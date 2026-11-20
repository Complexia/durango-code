// Usage view data: token usage read from the agents' own session logs on this
// machine, priced at API list prices (usage-pricing.js).
//
// Sources (each records every API call with its token breakdown):
//   claude — $CLAUDE_CONFIG_DIR/projects/<project>/<session>.jsonl, one
//            assistant line per content block carrying message.usage
//            (cache writes split 5m/1h, usage.speed "fast"). Subagents write
//            <session>/subagents/agent-<id>.jsonl. Forked sessions copy their
//            history, so calls are deduplicated by message id + request id.
//   codex  — $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl. Current
//            versions write token_usage_record per response (keyed by
//            response_id); older ones only cumulative token_count events,
//            counted as deltas. token_count also carries the plan's rate
//            limits, which the Limits view shows.
//   grok   — ~/.grok/sessions/<cwd>/<session>/usage.json, per turn and model,
//            with Grok Build's own cost estimate (costUsdTicks, 1e-10 USD).
//
// Parsing is incremental: logs are append-only, so each file's records and
// parser state are cached (userData/usage-cache.json) with the byte offset
// read so far, and a later scan reads only what was appended.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { priceUsage } from './usage-pricing.js';

const CACHE_VERSION = 1;
const CHUNK_BYTES = 4 * 1024 * 1024;
const RESCAN_AFTER_MS = 20_000;

export const usageLogRoots = (env = process.env, home = os.homedir()) => ({
  claude: path.join(path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')), 'projects'),
  codex: [
    path.join(path.resolve(env.CODEX_HOME || path.join(home, '.codex')), 'sessions'),
    path.join(path.resolve(env.CODEX_HOME || path.join(home, '.codex')), 'archived_sessions'),
  ],
  grok: path.join(home, '.grok', 'sessions'),
});

// Record layout (arrays keep the cache small):
//   [timeMs, model, input, cacheRead, cacheWrite5m, cacheWrite1h, output,
//    reasoning, flags, key, ownCost, promptTokens]
// input is uncached input; output includes reasoning. flags: 1 = fast
// (Claude fast mode / Codex priority tier), 2 = subagent call (Claude
// sidechain). ownCost is the agent's own cost estimate when it logs one.
const R = { t: 0, model: 1, input: 2, cacheRead: 3, cw5: 4, cw1h: 5, output: 6, reasoning: 7, flags: 8, key: 9, cost: 10, prompt: 11 };
const FLAG_FAST = 1;
const FLAG_SIDECHAIN = 2;

const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0);

// --- claude -------------------------------------------------------------------

export const parseClaudeLine = (line, file) => {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (!file.meta.cwd && typeof entry?.cwd === 'string') file.meta.cwd = entry.cwd;
  if (!file.meta.entrypoint && typeof entry?.entrypoint === 'string') file.meta.entrypoint = entry.entrypoint;
  if (entry?.type !== 'assistant') return;
  const message = entry.message;
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return;
  const model = typeof message.model === 'string' ? message.model : '';
  if (!model || model === '<synthetic>') return;
  const time = Date.parse(entry.timestamp);
  if (!Number.isFinite(time)) return;
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const cacheWrite1h = Math.min(cacheWrite, count(usage.cache_creation?.ephemeral_1h_input_tokens));
  const input = count(usage.input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const key = `${message.id ?? entry.uuid}:${entry.requestId ?? ''}`;
  const record = [
    time,
    model,
    input,
    cacheRead,
    cacheWrite - cacheWrite1h,
    cacheWrite1h,
    count(usage.output_tokens),
    count(usage.output_tokens_details?.thinking_tokens),
    (usage.speed === 'fast' ? FLAG_FAST : 0) | (entry.isSidechain ? FLAG_SIDECHAIN : 0),
    key,
    null,
    input + cacheRead + cacheWrite,
  ];
  // One API call is logged once per content block; the last line has the
  // final output count.
  const index = file.state.keys?.[key];
  if (index !== undefined) file.records[index] = record;
  else {
    file.state.keys ??= {};
    file.state.keys[key] = file.records.length;
    file.records.push(record);
  }
};

// --- codex --------------------------------------------------------------------

const codexTokens = (usage) => {
  const input = count(usage?.input_tokens);
  const cached = Math.min(input, count(usage?.cached_input_tokens));
  const cacheWrite = Math.min(input - cached, count(usage?.cache_write_input_tokens));
  return { input: input - cached - cacheWrite, cached, cacheWrite, prompt: input, output: count(usage?.output_tokens), reasoning: count(usage?.reasoning_output_tokens) };
};

export const parseCodexLine = (line, file) => {
  const kind = line.slice(0, 160);
  const relevant =
    kind.includes('"session_meta"') ||
    kind.includes('"turn_context"') ||
    kind.includes('"token_usage_record"') ||
    line.includes('"token_count"') ||
    (kind.includes('"event_msg"') && line.includes('"service_tier"'));
  if (!relevant) return;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const payload = entry?.payload ?? {};
  const time = Date.parse(entry.timestamp);
  const state = file.state;
  if (entry.type === 'session_meta') {
    if (!file.meta.sessionId && typeof payload.id === 'string') file.meta.sessionId = payload.id;
    if (!file.meta.cwd && typeof payload.cwd === 'string') file.meta.cwd = payload.cwd;
    if (!file.meta.originator && typeof payload.originator === 'string') file.meta.originator = payload.originator;
    if (payload.thread_source === 'subagent' || (payload.source && typeof payload.source === 'object' && payload.source.subagent)) {
      file.meta.subagent = true;
    }
    return;
  }
  if (entry.type === 'turn_context') {
    if (typeof payload.model === 'string') state.model = payload.model;
    if (typeof payload.service_tier === 'string') state.tier = payload.service_tier;
    return;
  }
  if (entry.type === 'event_msg' && payload.type !== 'token_count') {
    const settings = payload.thread_settings ?? payload;
    if (typeof settings?.model === 'string') state.model = settings.model;
    if (typeof settings?.service_tier === 'string') state.tier = settings.service_tier;
    return;
  }
  const fast = state.tier === 'priority' || state.tier === 'fast' ? FLAG_FAST : 0;
  if (entry.type === 'token_usage_record') {
    if (!Number.isFinite(time)) return;
    if (!state.records) {
      // This version logs every response: drop the token_count deltas.
      state.records = true;
      file.records = file.records.filter((record) => record[R.key] !== null && !String(record[R.key]).startsWith('delta:'));
    }
    const tokens = codexTokens(payload.usage);
    file.records.push([
      time,
      state.model || 'unknown',
      tokens.input,
      tokens.cached,
      tokens.cacheWrite,
      0,
      tokens.output,
      tokens.reasoning,
      fast,
      `resp:${payload.response_id ?? `${file.meta.sessionId}:${time}`}`,
      null,
      tokens.prompt,
    ]);
    return;
  }
  if (payload.type !== 'token_count') return;
  if (payload.rate_limits && Number.isFinite(time)) state.rateLimits = { at: time, value: payload.rate_limits };
  if (state.records) return;
  const total = payload.info?.total_token_usage;
  if (!total || !Number.isFinite(time)) return;
  const previous = state.total ?? null;
  const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
  const reset = previous && fields.some((field) => count(total[field]) < count(previous[field]));
  const delta = {};
  for (const field of fields) delta[field] = count(total[field]) - (previous && !reset ? count(previous[field]) : 0);
  state.total = Object.fromEntries(fields.map((field) => [field, count(total[field])]));
  if (delta.input_tokens + delta.output_tokens <= 0) return;
  const tokens = codexTokens(delta);
  file.records.push([time, state.model || 'unknown', tokens.input, tokens.cached, tokens.cacheWrite, 0, tokens.output, tokens.reasoning, fast, `delta:${file.records.length}`, null, 0]);
};

// --- grok ---------------------------------------------------------------------

export const parseGrokUsage = (text, file) => {
  let usage;
  try {
    usage = JSON.parse(text);
  } catch {
    return;
  }
  file.records = [];
  file.meta.sessionId = typeof usage?.sessionId === 'string' ? usage.sessionId : file.meta.sessionId;
  for (const turn of Array.isArray(usage?.turns) ? usage.turns : []) {
    const time = Date.parse(turn?.endedAt);
    if (!Number.isFinite(time)) continue;
    const byModel = turn.modelUsage && typeof turn.modelUsage === 'object' ? Object.entries(turn.modelUsage) : [[turn.primaryModelId, turn]];
    for (const [model, part] of byModel) {
      const input = count(part?.inputTokens);
      const cached = Math.min(input, count(part?.cachedReadTokens));
      const cacheWrite = Math.min(input - cached, count(part?.cacheCreationTokens));
      const ticks = Number(part?.costUsdTicks);
      file.records.push([
        time,
        String(model || 'grok'),
        input - cached - cacheWrite,
        cached,
        cacheWrite,
        0,
        count(part?.outputTokens),
        count(part?.reasoningTokens),
        0,
        `grok:${file.meta.sessionId}:${turn.turnNumber}:${model}`,
        Number.isFinite(ticks) && ticks >= 0 ? ticks / 1e10 : null,
        0,
      ]);
    }
  }
};

// --- file discovery -----------------------------------------------------------

const listJsonl = async (root, depth) => {
  const out = [];
  const walk = async (dir, level) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (level < depth) await walk(full, level + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  await walk(root, 0);
  return out;
};

export const discoverUsageFiles = async (roots = usageLogRoots()) => {
  const files = [];
  for (const file of await listJsonl(roots.claude, 3)) {
    const relative = path.relative(roots.claude, file).split(path.sep);
    // <project>/<session>.jsonl or <project>/<session>/subagents/agent-<id>.jsonl
    if (relative.length === 2) {
      files.push({ path: file, provider: 'claude', sessionId: path.basename(file, '.jsonl') });
    } else if (relative.length === 4 && relative[2] === 'subagents') {
      files.push({
        path: file,
        provider: 'claude',
        sessionId: path.basename(file, '.jsonl').replace(/^agent-/, ''),
        parentSessionId: relative[1],
      });
    }
  }
  for (const root of roots.codex) {
    for (const file of await listJsonl(root, 4)) {
      if (!path.basename(file).startsWith('rollout-')) continue;
      const id = path.basename(file, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
      files.push({ path: file, provider: 'codex', sessionId: id ?? path.basename(file, '.jsonl') });
    }
  }
  let projects = [];
  try {
    projects = await fs.readdir(roots.grok, { withFileTypes: true });
  } catch {
    projects = [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let sessions = [];
    try {
      sessions = await fs.readdir(path.join(roots.grok, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      files.push({
        path: path.join(roots.grok, project.name, session.name, 'usage.json'),
        provider: 'grok',
        sessionId: session.name,
        cwd: (() => {
          try {
            return decodeURIComponent(project.name);
          } catch {
            return null;
          }
        })(),
      });
    }
  }
  return files;
};

// --- incremental reading --------------------------------------------------------

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

const freshEntry = (descriptor) => ({
  provider: descriptor.provider,
  sessionId: descriptor.sessionId,
  parentSessionId: descriptor.parentSessionId ?? null,
  size: 0,
  mtimeMs: 0,
  offset: 0,
  meta: descriptor.cwd ? { cwd: descriptor.cwd } : {},
  state: {},
  records: [],
});

const readAppended = async (filePath, entry, parseLine) => {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let position = entry.offset;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      const lastNewline = data.lastIndexOf(10);
      if (lastNewline === -1) {
        carry = Buffer.from(data);
        continue;
      }
      const complete = data.subarray(0, lastNewline);
      carry = Buffer.from(data.subarray(lastNewline + 1));
      entry.offset = position - carry.length;
      const text = complete.toString('utf8');
      let start = 0;
      while (start < text.length) {
        let end = text.indexOf('\n', start);
        if (end === -1) end = text.length;
        if (end > start) parseLine(text.slice(start, end), entry);
        start = end + 1;
      }
      data = null;
      await yieldToEventLoop();
    }
  } finally {
    await handle.close();
  }
};

const rebuildKeyIndex = (entry) => {
  if (entry.provider !== 'claude') return;
  entry.state.keys = {};
  entry.records.forEach((record, index) => {
    entry.state.keys[record[R.key]] = index;
  });
};

export const createUsageStore = ({ cacheFile = null, roots = usageLogRoots(), onProgress = null } = {}) => {
  let files = new Map();
  let loaded = false;
  let scanning = null;
  let lastScanAt = 0;
  let progress = { done: 0, total: 0, scanning: false };

  const load = async () => {
    if (loaded) return;
    loaded = true;
    if (!cacheFile) return;
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (cached?.version !== CACHE_VERSION) return;
      for (const [filePath, entry] of Object.entries(cached.files ?? {})) {
        rebuildKeyIndex(entry);
        files.set(filePath, entry);
      }
    } catch {
      // First run, or an unreadable cache: rescan everything.
    }
  };

  const save = async () => {
    if (!cacheFile) return;
    const out = {};
    for (const [filePath, entry] of files) {
      const { keys, ...state } = entry.state;
      out[filePath] = { ...entry, state };
    }
    const temp = `${cacheFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ version: CACHE_VERSION, files: out }));
    await fs.rename(temp, cacheFile);
  };

  const scanFile = async (descriptor) => {
    let stat;
    try {
      stat = await fs.stat(descriptor.path);
    } catch {
      files.delete(descriptor.path);
      return false;
    }
    let entry = files.get(descriptor.path);
    if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) return false;
    // Rewritten (smaller) files and non-append formats start over.
    if (!entry || stat.size < entry.offset || descriptor.provider === 'grok') entry = freshEntry(descriptor);
    if (descriptor.provider === 'grok') {
      parseGrokUsage(await fs.readFile(descriptor.path, 'utf8'), entry);
    } else {
      await readAppended(descriptor.path, entry, descriptor.provider === 'claude' ? parseClaudeLine : parseCodexLine);
    }
    entry.size = stat.size;
    entry.mtimeMs = stat.mtimeMs;
    files.set(descriptor.path, entry);
    return true;
  };

  const scan = async ({ force = false } = {}) => {
    await load();
    if (scanning) return scanning;
    if (!force && Date.now() - lastScanAt < RESCAN_AFTER_MS) return false;
    scanning = (async () => {
      const descriptors = await discoverUsageFiles(roots);
      const present = new Set(descriptors.map((descriptor) => descriptor.path));
      let changed = false;
      for (const filePath of files.keys()) {
        if (!present.has(filePath)) {
          files.delete(filePath);
          changed = true;
        }
      }
      progress = { done: 0, total: descriptors.length, scanning: true };
      onProgress?.(progress);
      let lastReport = Date.now();
      for (const descriptor of descriptors) {
        try {
          if (await scanFile(descriptor)) changed = true;
        } catch {
          // An unreadable log is skipped; the rest still count.
        }
        progress.done += 1;
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now();
          onProgress?.({ ...progress });
        }
      }
      progress = { done: descriptors.length, total: descriptors.length, scanning: false };
      onProgress?.(progress);
      lastScanAt = Date.now();
      if (changed) await save().catch(() => {});
      return changed;
    })();
    try {
      return await scanning;
    } finally {
      scanning = null;
    }
  };

  return {
    scan,
    progress: () => ({ ...progress }),
    entries: () => files,
  };
};

// --- report -------------------------------------------------------------------

export const USAGE_PROVIDER_LABELS = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build' };
export const USAGE_SOURCE_LABELS = {
  thread: 'Threads',
  subagent: 'Subagents',
  bot: 'Bots',
  other: 'Not linked to a thread',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const usageRangeWindow = (range, now = Date.now()) => {
  if (range === '24h') {
    const end = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
    return { start: end - 24 * HOUR_MS, end, bucketMs: HOUR_MS, bucket: 'hour' };
  }
  const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + 1);
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));
  return { start: start.getTime(), end: end.getTime(), bucketMs: DAY_MS, bucket: 'day' };
};

// Local-day buckets (DST-safe): the index of the day `time` falls on.
const bucketIndex = (window, time) => {
  if (window.bucket === 'hour') return Math.floor((time - window.start) / HOUR_MS);
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  const start = new Date(window.start);
  return Math.round((day.getTime() - start.getTime()) / DAY_MS);
};

const bucketStarts = (window) => {
  const starts = [];
  if (window.bucket === 'hour') {
    for (let t = window.start; t < window.end; t += HOUR_MS) starts.push(t);
    return starts;
  }
  const cursor = new Date(window.start);
  while (cursor.getTime() < window.end) {
    starts.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return starts;
};

const isBotCwd = (cwd) => typeof cwd === 'string' && /[\\/]orion[\\/]bots[\\/]/i.test(cwd);

/**
 * Which part of Durango Code a session belongs to. `links` maps agent session
 * ids to 'thread' | 'subagent' (from the renderer's thread list).
 */
export const classifyUsageSession = (entry, links) => {
  const own = links.get(entry.sessionId);
  if (own) return own;
  if (isBotCwd(entry.meta?.cwd)) return 'bot';
  if (entry.parentSessionId) {
    const parent = links.get(entry.parentSessionId);
    if (parent) return 'subagent';
  }
  return 'other';
};

const emptyTokens = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
const addTokens = (into, record) => {
  into.input += record[R.input];
  into.cacheRead += record[R.cacheRead];
  into.cacheWrite += record[R.cw5] + record[R.cw1h];
  into.output += record[R.output];
  into.reasoning += record[R.reasoning];
};
const tokenTotal = (tokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;

export const latestCodexLimits = (entries) => {
  let latest = null;
  for (const entry of entries.values()) {
    const limits = entry.provider === 'codex' ? entry.state?.rateLimits : null;
    if (limits && (!latest || limits.at > latest.at)) latest = limits;
  }
  return latest;
};

/**
 * Aggregates cached records into the Usage view's report.
 * filters: { range: '24h'|'7d'|'30d'|'90d', provider: 'all'|id, source: 'all'|'durango'|kind }
 */
export const buildUsageReport = (entries, { range = '7d', provider = 'all', source = 'all', links = new Map(), now = Date.now() } = {}) => {
  const window = usageRangeWindow(range, now);
  const starts = bucketStarts(window);
  const series = starts.map((start) => ({ start, cost: {}, tokens: {} }));
  const providers = new Map();
  const models = new Map();
  const sources = new Map();
  const sessions = new Set();
  const totals = { tokens: emptyTokens(), cost: 0, savings: 0, unpricedTokens: 0, ownCostTokens: 0 };
  const costByType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 };
  const costBySpeed = { standard: 0, fast: 0, fastPremium: 0, fastTokens: 0 };
  const unpricedModels = new Set();
  const seen = new Set();
  const availableProviders = new Set();

  // Earliest file first, so a call copied into a fork is credited to the
  // session that made it.
  const ordered = [...entries.values()]
    .filter((entry) => entry.records.length > 0)
    .sort((a, b) => a.records[0][R.t] - b.records[0][R.t]);

  for (const entry of ordered) {
    availableProviders.add(entry.provider);
    const kind = classifyUsageSession(entry, links);
    for (const record of entry.records) {
      const key = record[R.key];
      if (key && !String(key).startsWith('delta:')) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const time = record[R.t];
      if (time < window.start || time >= window.end) continue;
      if (provider !== 'all' && entry.provider !== provider) continue;
      const recordKind = kind === 'thread' && record[R.flags] & FLAG_SIDECHAIN ? 'subagent' : kind;
      if (source === 'durango' ? recordKind === 'other' : source !== 'all' && recordKind !== source) continue;

      const tokens = {
        input: record[R.input],
        cacheRead: record[R.cacheRead],
        cacheWrite5m: record[R.cw5],
        cacheWrite1h: record[R.cw1h],
        output: record[R.output],
      };
      const fast = Boolean(record[R.flags] & FLAG_FAST);
      const priced = priceUsage(entry.provider, record[R.model], tokens, { fast, promptTokens: record[R.prompt] ?? 0 });
      const own = typeof record[R.cost] === 'number' ? record[R.cost] : null;
      let cost = 0;
      if (own !== null) {
        // The agent's own estimate wins; its split by type is unknown.
        cost = own;
        costByType.other += own;
        totals.ownCostTokens += tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.output;
        if (priced) totals.savings += priced.savings;
      } else if (priced) {
        cost = priced.parts.input + priced.parts.cacheRead + priced.parts.cacheWrite + priced.parts.output;
        costByType.input += priced.parts.input;
        costByType.cacheRead += priced.parts.cacheRead;
        costByType.cacheWrite += priced.parts.cacheWrite;
        costByType.output += priced.parts.output;
        totals.savings += priced.savings;
      } else {
        unpricedModels.add(record[R.model]);
        totals.unpricedTokens += tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.output;
      }
      if (fast) {
        costBySpeed.fast += cost;
        costBySpeed.fastTokens += tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.output;
        if (priced?.fastPriced && own === null) {
          const standard = priceUsage(entry.provider, record[R.model], tokens, { promptTokens: record[R.prompt] ?? 0 });
          if (standard) {
            const standardCost = standard.parts.input + standard.parts.cacheRead + standard.parts.cacheWrite + standard.parts.output;
            costBySpeed.fastPremium += Math.max(0, cost - standardCost);
          }
        }
      } else costBySpeed.standard += cost;

      const sessionKey = `${entry.provider}:${entry.sessionId}`;
      sessions.add(sessionKey);
      totals.cost += cost;
      addTokens(totals.tokens, record);

      const providerRow = providers.get(entry.provider) ?? { id: entry.provider, cost: 0, tokens: emptyTokens(), sessions: new Set() };
      providerRow.cost += cost;
      addTokens(providerRow.tokens, record);
      providerRow.sessions.add(sessionKey);
      providers.set(entry.provider, providerRow);

      const modelKey = `${entry.provider}:${record[R.model]}`;
      const modelRow = models.get(modelKey) ?? { provider: entry.provider, model: record[R.model], cost: 0, tokens: emptyTokens(), sessions: new Set(), priced: Boolean(priced) || own !== null };
      modelRow.cost += cost;
      addTokens(modelRow.tokens, record);
      modelRow.sessions.add(sessionKey);
      models.set(modelKey, modelRow);

      const sourceRow = sources.get(recordKind) ?? { id: recordKind, cost: 0, tokens: emptyTokens(), sessions: new Set() };
      sourceRow.cost += cost;
      addTokens(sourceRow.tokens, record);
      sourceRow.sessions.add(sessionKey);
      sources.set(recordKind, sourceRow);

      const index = bucketIndex(window, time);
      const bucket = series[index];
      if (bucket) {
        bucket.cost[entry.provider] = (bucket.cost[entry.provider] ?? 0) + cost;
        bucket.tokens[entry.provider] =
          (bucket.tokens[entry.provider] ?? 0) + record[R.input] + record[R.cacheRead] + record[R.cw5] + record[R.cw1h] + record[R.output];
      }
    }
  }

  const finishRow = (row) => ({
    ...row,
    sessions: row.sessions.size,
    totalTokens: tokenTotal(row.tokens),
    share: totals.cost > 0 ? row.cost / totals.cost : 0,
    tokenShare: tokenTotal(totals.tokens) > 0 ? tokenTotal(row.tokens) / tokenTotal(totals.tokens) : 0,
  });

  return {
    range,
    window,
    totals: { ...totals, sessions: sessions.size, totalTokens: tokenTotal(totals.tokens) },
    providers: [...providers.values()].map(finishRow).sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens),
    models: [...models.values()].map(finishRow).sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens),
    sources: [...sources.values()].map(finishRow).sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens),
    series,
    costByType,
    costBySpeed,
    unpricedModels: [...unpricedModels].sort(),
    availableProviders: [...availableProviders].sort(),
  };
};
