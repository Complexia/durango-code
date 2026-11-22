// Plan limits read live from the providers' own quota endpoints, with the
// sign-in their CLI already stored (Settings → Usage). Every provider
// (Claude Code, Codex, Antigravity, Grok Build) is queried directly; Claude
// and Codex also keep local fallbacks from SDK rate_limit_event messages
// (usage-limits.js) and Codex session logs (usage-stats.js). Nothing is
// refreshed or written: an expired token reads as "run a turn to renew it".

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_MS = 60_000;

const execText = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 8000, maxBuffer: 1 << 20 }, (error, stdout) =>
      resolve(error ? null : String(stdout || '').trim())
    );
  });

const fetchJson = async (url, init) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, ok: response.ok, body };
};

const clampPercent = (value) => Math.min(100, Math.max(0, value));
const isoTime = (value) => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

// --- Claude Code -------------------------------------------------------------

const titleCase = (value) => {
  const text = String(value || '').trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : null;
};

const claudeCredentialsPath = () =>
  path.join(path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')), '.credentials.json');

const readClaudeToken = async () => {
  let raw = null;
  if (process.platform === 'darwin') {
    raw = await execText('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
  }
  if (!raw) {
    try {
      raw = await fs.readFile(claudeCredentialsPath(), 'utf8');
    } catch {
      raw = null;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const oauth = parsed?.claudeAiOauth ?? parsed;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null;
    const rawExpiry = Number(oauth.expiresAt);
    const expiresAt = Number.isFinite(rawExpiry) && rawExpiry > 0 ? (rawExpiry < 1e12 ? rawExpiry * 1000 : rawExpiry) : null;
    return {
      accessToken: oauth.accessToken,
      expiresAt,
      plan: titleCase(oauth.subscriptionType),
    };
  } catch {
    return null;
  }
};

const CLAUDE_OAUTH_WINDOWS = [
  ['five_hour', '5-hour session', 300],
  ['seven_day', 'Weekly · all models', 10080],
  ['seven_day_opus', 'Weekly · Opus', 10080],
  ['seven_day_sonnet', 'Weekly · Sonnet', 10080],
  ['seven_day_cowork', 'Weekly · Cowork', 10080],
];

/** /api/oauth/usage → normalized rate-limit windows (5-hour, weekly, scoped model limits, extra usage). */
export const claudeWindowsFromOAuthUsage = (body) => {
  if (!body || typeof body !== 'object') return [];
  const windows = [];
  const seenIds = new Set();
  const seenModels = new Set();
  for (const [key, label, windowMinutes] of CLAUDE_OAUTH_WINDOWS) {
    const entry = body[key];
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.utilization !== 'number' || !Number.isFinite(entry.utilization)) continue;
    windows.push({
      id: key,
      label,
      usedPercent: clampPercent(entry.utilization),
      resetsAt: isoTime(entry.resets_at),
      windowMinutes,
    });
    seenIds.add(key);
    if (key === 'seven_day_opus') seenModels.add('opus');
    if (key === 'seven_day_sonnet') seenModels.add('sonnet');
  }
  for (const limit of Array.isArray(body.limits) ? body.limits : []) {
    if (!limit || typeof limit !== 'object') continue;
    if (typeof limit.percent !== 'number' || !Number.isFinite(limit.percent)) continue;
    if ((limit.kind === 'five_hour' || limit.group === '5h' || limit.group === 'session') && !seenIds.has('five_hour')) {
      windows.unshift({
        id: 'five_hour',
        label: '5-hour session',
        usedPercent: clampPercent(limit.percent),
        resetsAt: isoTime(limit.resets_at),
        windowMinutes: 300,
      });
      seenIds.add('five_hour');
      continue;
    }
    if (limit.kind === 'weekly_all' && !seenIds.has('seven_day')) {
      windows.push({
        id: 'seven_day',
        label: 'Weekly · all models',
        usedPercent: clampPercent(limit.percent),
        resetsAt: isoTime(limit.resets_at),
        windowMinutes: 10080,
      });
      seenIds.add('seven_day');
      continue;
    }
    const scopedName = typeof limit.scope?.model?.display_name === 'string' ? limit.scope.model.display_name.trim() : '';
    if (scopedName && !seenModels.has(scopedName.toLowerCase())) {
      const id = `weekly_${scopedName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
      if (!seenIds.has(id)) {
        windows.push({
          id,
          label: `Weekly · ${scopedName}`,
          usedPercent: clampPercent(limit.percent),
          resetsAt: isoTime(limit.resets_at),
          windowMinutes: limit.group === '5h' ? 300 : 10080,
        });
        seenIds.add(id);
        seenModels.add(scopedName.toLowerCase());
      }
    }
  }
  if (body.extra_usage?.is_enabled && typeof body.extra_usage.utilization === 'number' && Number.isFinite(body.extra_usage.utilization)) {
    windows.push({
      id: 'extra_usage',
      label: 'Extra usage',
      usedPercent: clampPercent(body.extra_usage.utilization),
      resetsAt: null,
      windowMinutes: null,
    });
  }
  return windows;
};

const claudeExtraUsageNote = (body) => {
  const extra = body?.extra_usage;
  const spend = body?.spend;
  if (extra?.is_enabled) {
    const currency = extra.currency || 'USD';
    const scale = 10 ** (Number.isFinite(Number(extra.decimal_places)) ? Number(extra.decimal_places) : 2);
    const fmt = (minor) =>
      typeof minor === 'number' && Number.isFinite(minor)
        ? (minor / scale).toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : null;
    const used = fmt(extra.used_credits);
    const limit = fmt(extra.monthly_limit);
    if (used && limit) return `Extra usage: ${used} of ${limit}`;
    if (used) return `Extra usage: ${used} used`;
    return 'Extra usage enabled';
  }
  if (spend?.enabled && typeof spend.used?.amount_minor === 'number') {
    const scale = 10 ** (Number.isFinite(Number(spend.used.exponent)) ? Number(spend.used.exponent) : 2);
    const used = (spend.used.amount_minor / scale).toLocaleString('en-US', {
      style: 'currency',
      currency: spend.used.currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `Extra usage: ${used} used`;
  }
  return null;
};

export const readClaudeLimits = async () => {
  const token = await readClaudeToken();
  if (!token) {
    if (process.env.ANTHROPIC_API_KEY) {
      return { status: 'unavailable', detail: 'Claude Code uses an API key here (ANTHROPIC_API_KEY), which has no plan limits.' };
    }
    return { status: 'signed-out', detail: 'Sign in to Claude Code to see live plan limits.' };
  }
  if (token.expiresAt && token.expiresAt <= Date.now() + 60_000) {
    return { status: 'expired', detail: "Claude Code's sign-in token has expired. Run a Claude turn to renew it, then refresh." };
  }
  try {
    const response = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0',
      },
    });
    if (response.status === 401) {
      return { status: 'expired', detail: "Claude Code's sign-in has expired. Run a Claude turn to renew it, then refresh." };
    }
    if (!response.ok) {
      const message = typeof response.body?.error === 'string' ? response.body.error : response.body?.error?.message;
      return { status: 'error', detail: message || `HTTP ${response.status}` };
    }
    const windows = claudeWindowsFromOAuthUsage(response.body);
    const extra = claudeExtraUsageNote(response.body);
    return {
      status: 'ok',
      windows,
      ...(token.plan ? { plan: token.plan } : {}),
      ...(extra ? { extra } : {}),
    };
  } catch (error) {
    return { status: 'error', detail: error?.message || String(error) };
  }
};

// --- Antigravity -------------------------------------------------------------

// agy stores its Google sign-in with go-keyring: service "gemini", account
// "antigravity" (macOS keychain via /usr/bin/security, which the item trusts;
// libsecret on Linux). The value is `go-keyring-base64:<base64 JSON>`.
export const decodeGoKeyringValue = (value) => {
  const text = String(value || '').trim();
  if (text.startsWith('go-keyring-base64:')) return Buffer.from(text.slice(18), 'base64').toString('utf8');
  if (text.startsWith('go-keyring-encoded:')) return Buffer.from(text.slice(19), 'hex').toString('utf8');
  return text;
};

const readAntigravityToken = async () => {
  // agy 1.5 keeps the sign-in in a file under its data dir when it can (and
  // falls back to the OS keyring), the same JSON either way.
  let raw = null;
  try {
    raw = (await fs.readFile(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).trim() || null;
  } catch {}
  if (!raw && process.platform === 'darwin') {
    raw = await execText('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w']);
  } else if (!raw && process.platform === 'linux') {
    raw = await execText('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity']);
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeGoKeyringValue(raw));
    const token = parsed?.token;
    if (typeof token?.access_token !== 'string' || !token.access_token) return null;
    return { accessToken: token.access_token, expiresAt: isoTime(token.expiry) };
  } catch {
    return null;
  }
};

const ANTIGRAVITY_HOSTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
const antigravityUserAgent = () =>
  `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`;

const antigravityFamily = (bucketId, groupName) => {
  if (groupName) return groupName;
  if (bucketId.startsWith('3p-')) return 'Claude & GPT';
  if (bucketId.startsWith('gemini-')) return 'Gemini';
  return bucketId;
};

/** retrieveUserQuotaSummary → windows: `remainingFraction` per bucket, grouped by model family. */
export const antigravityWindowsFromQuotaSummary = (summary) => {
  const groups = Array.isArray(summary?.groups) && summary.groups.some((group) => group?.buckets?.length)
    ? summary.groups
    : [{ buckets: summary?.buckets }];
  const windows = [];
  for (const group of groups) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      if (!bucket || bucket.disabled || typeof bucket.bucketId !== 'string') continue;
      if (typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction)) continue;
      const family = antigravityFamily(bucket.bucketId, typeof group?.displayName === 'string' ? group.displayName.trim() : '');
      const windowMinutes = bucket.window === '5h' ? 300 : bucket.window === 'weekly' ? 10080 : null;
      const period = windowMinutes === 300 ? '5-hour' : windowMinutes === 10080 ? 'Weekly' : bucket.displayName || 'Quota';
      windows.push({
        id: bucket.bucketId,
        label: `${family} · ${period}`,
        usedPercent: clampPercent((1 - Math.min(1, Math.max(0, bucket.remainingFraction))) * 100),
        resetsAt: isoTime(bucket.resetTime),
        windowMinutes,
        ...(typeof bucket.description === 'string' && bucket.description ? { detail: bucket.description } : {}),
      });
    }
  }
  // 5-hour windows before weekly ones within a family.
  return windows.sort((a, b) => a.label.split(' · ')[0].localeCompare(b.label.split(' · ')[0]) || (a.windowMinutes ?? 1e9) - (b.windowMinutes ?? 1e9));
};

const antigravityPlanLabel = (tier) => {
  if (tier?.id === 'free-tier') return 'Free';
  const name = typeof tier?.name === 'string' ? tier.name.trim() : '';
  return name && name !== 'Antigravity' ? name : null;
};

export const readAntigravityLimits = async () => {
  const token = await readAntigravityToken();
  if (!token) {
    return { status: 'signed-out', detail: 'Sign in to Antigravity to see its limits.' };
  }
  if (token.expiresAt && token.expiresAt <= Date.now() + 60_000) {
    return { status: 'expired', detail: "Antigravity's sign-in token has expired. Run an Antigravity turn to renew it, then refresh." };
  }
  const headers = {
    Authorization: `Bearer ${token.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': antigravityUserAgent(),
  };
  let lastError = null;
  for (const host of ANTIGRAVITY_HOSTS) {
    try {
      // The quota belongs to the account's Code Assist project, which
      // loadCodeAssist reports; without it the summary is refused.
      const loaded = await fetchJson(`${host}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
      });
      const project = loaded.body?.cloudaicompanionProject?.id ?? loaded.body?.cloudaicompanionProject;
      const summary = await fetchJson(`${host}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers,
        body: JSON.stringify(typeof project === 'string' && project ? { project } : {}),
      });
      if (!summary.ok) {
        lastError = summary.body?.error?.message || `HTTP ${summary.status}`;
        continue;
      }
      const windows = antigravityWindowsFromQuotaSummary(summary.body);
      return {
        status: 'ok',
        windows,
        plan: antigravityPlanLabel(loaded.body?.currentTier),
        ...(typeof summary.body?.description === 'string' ? { detail: summary.body.description } : {}),
      };
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }
  return { status: 'error', detail: lastError || 'Antigravity limits are unavailable.' };
};

// --- Grok --------------------------------------------------------------------

const GROK_AUTH_KEYS = ['https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828', 'https://accounts.x.ai/sign-in'];

/** The billing response's one window: the current credit period. */
export const grokWindowsFromBilling = (body) => {
  const config = body?.config;
  if (!config || typeof config !== 'object') return [];
  const period = config.currentPeriod ?? {};
  const type = String(period.type || '').replace(/^USAGE_PERIOD_TYPE_/, '');
  const start = isoTime(period.start);
  const end = isoTime(period.end);
  const label = type === 'WEEKLY' ? 'Weekly' : type === 'MONTHLY' ? 'Monthly' : 'Subscription';
  const used =
    typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)
      ? clampPercent(config.creditUsagePercent)
      : (type === 'WEEKLY' || type === 'MONTHLY') && start !== null && end !== null && start < end
        ? 0
        : null;
  if (used === null) return [];
  return [
    {
      id: 'subscription',
      label,
      usedPercent: used,
      resetsAt: end,
      windowMinutes: start !== null && end !== null && end > start ? Math.round((end - start) / 60000) : null,
    },
  ];
};

export const readGrokLimits = async () => {
  if (process.env.XAI_API_KEY) return { status: 'unavailable', detail: 'Grok uses an API key here (XAI_API_KEY), which has no plan limits.' };
  const home = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
  let auth = null;
  try {
    auth = JSON.parse(process.env.GROK_AUTH || (await fs.readFile(path.join(home, 'auth.json'), 'utf8')));
  } catch {
    return { status: 'signed-out', detail: 'Sign in to Grok Build to see its limits.' };
  }
  const entry = GROK_AUTH_KEYS.map((key) => auth?.[key]).find((value) => value && value.auth_mode !== 'api_key' && typeof value.key === 'string');
  if (!entry) return { status: 'signed-out', detail: 'Sign in to Grok Build with your grok.com account to see its limits.' };
  try {
    const response = await fetchJson('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
      headers: { Authorization: `Bearer ${entry.key}` },
    });
    if (response.status === 401) {
      return { status: 'expired', detail: "Grok's sign-in has expired. Run a Grok turn to renew it, then refresh." };
    }
    if (!response.ok) {
      const message = typeof response.body?.error === 'string' ? response.body.error : response.body?.error?.message;
      if (response.status === 403 && /privacy-mode/i.test(String(message))) {
        return { status: 'unavailable', detail: 'Grok shows plan limits only with Privacy Mode on in your grok.com settings.' };
      }
      return { status: 'error', detail: message || `HTTP ${response.status}` };
    }
    return { status: 'ok', windows: grokWindowsFromBilling(response.body) };
  } catch (error) {
    return { status: 'error', detail: error?.message || String(error) };
  }
};

// --- Codex -------------------------------------------------------------------

// The shared Codex app-server answers account/rateLimits/read live; the
// result uses the session logs' snake_case shape the Limits view already
// renders (latestCodexLimits in usage-stats.js).
const snakeWindow = (window) =>
  window && typeof window === 'object'
    ? {
        used_percent: typeof window.usedPercent === 'number' ? window.usedPercent : null,
        window_minutes: typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null,
        resets_at: typeof window.resetsAt === 'number' ? window.resetsAt : null,
      }
    : null;

export const codexLimitsFromRateLimitsRead = (result) => {
  const snapshot = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const credits = snapshot.credits && typeof snapshot.credits === 'object'
    ? { balance: snapshot.credits.balance ?? null, unlimited: snapshot.credits.unlimited === true, has_credits: snapshot.credits.hasCredits === true }
    : null;
  return {
    at: Date.now(),
    live: true,
    value: {
      primary: snakeWindow(snapshot.primary),
      secondary: snakeWindow(snapshot.secondary),
      ...(credits ? { credits } : {}),
      plan_type: typeof snapshot.planType === 'string' ? snapshot.planType : null,
    },
  };
};

/** `manager` is codexAppServerManager; null unless its shared app-server is already running. */
export const readCodexLiveLimits = async (manager, clientVersion = '0.0.0') => {
  // Only borrow a server that is already up: opening the Limits tab must not
  // start Codex for someone who doesn't use it (the session-log snapshot
  // covers that case).
  if (!manager?.acquire || manager.snapshot?.().running !== true) return null;
  const lease = await manager.acquire().catch(() => null);
  if (!lease?.persistent || !lease.child) {
    lease?.release?.();
    return null;
  }
  const { child } = lease;
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const onData = (data) => {
    buffer += data.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && !message.method && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {}
    }
  };
  child.stdout.on('data', onData);
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        pending.delete(id);
        resolve({ error: { message: 'closed' } });
      }
      setTimeout(() => {
        if (pending.delete(id)) resolve({ error: { message: 'timeout' } });
      }, REQUEST_TIMEOUT_MS);
    });
  try {
    const init = await request('initialize', {
      clientInfo: { name: 'orion', title: 'Durango Code', version: clientVersion },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (init.error) return null;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    const read = await request('account/rateLimits/read', null);
    return read.error ? null : codexLimitsFromRateLimitsRead(read.result);
  } catch {
    return null;
  } finally {
    child.stdout.off?.('data', onData);
    lease.release();
  }
};

const whamWindow = (window) =>
  window && typeof window === 'object'
    ? {
        used_percent: typeof window.used_percent === 'number' && Number.isFinite(window.used_percent) ? clampPercent(window.used_percent) : null,
        window_minutes:
          typeof window.limit_window_seconds === 'number' && Number.isFinite(window.limit_window_seconds) && window.limit_window_seconds > 0
            ? Math.round(window.limit_window_seconds / 60)
            : null,
        resets_at: typeof window.reset_at === 'number' && Number.isFinite(window.reset_at) ? window.reset_at : null,
      }
    : null;

/** ChatGPT /backend-api/wham/usage → Codex limits snapshot (same shape as session logs + app-server). */
export const codexLimitsFromWhamUsage = (body) => {
  if (!body || typeof body !== 'object') return null;
  const primary = whamWindow(body.rate_limit?.primary_window);
  const secondary = whamWindow(body.rate_limit?.secondary_window);
  const additional = [];
  const codeReview = whamWindow(body.code_review_rate_limit?.primary_window);
  if (codeReview) additional.push({ label: 'Code review', ...codeReview });
  for (const extra of Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []) {
    const win = whamWindow(extra?.rate_limit?.primary_window);
    if (!win) continue;
    const label = String(extra.limit_name || extra.metered_feature || 'Additional limit').trim();
    additional.push({ label, ...win });
  }
  const credits =
    body.credits && typeof body.credits === 'object'
      ? {
          balance: body.credits.balance ?? null,
          unlimited: body.credits.unlimited === true,
          has_credits: body.credits.has_credits === true,
        }
      : null;
  if (!primary && !secondary && !additional.length && !credits) return null;
  return {
    at: Date.now(),
    live: true,
    value: {
      primary,
      secondary,
      ...(additional.length ? { additional } : {}),
      ...(credits ? { credits } : {}),
      plan_type: typeof body.plan_type === 'string' ? body.plan_type : null,
      ...(typeof body.rate_limit_reached_type === 'string' ? { rate_limit_reached_type: body.rate_limit_reached_type } : {}),
    },
  };
};

export const readCodexWhamLimits = async () => {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  let auth = null;
  try {
    auth = JSON.parse(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8'));
  } catch {
    if (process.env.OPENAI_API_KEY) {
      return { status: 'unavailable', detail: 'Codex uses an API key here (OPENAI_API_KEY), which has no plan limits.' };
    }
    return { status: 'signed-out', detail: 'Sign in to Codex with your ChatGPT account to see live limits.' };
  }
  const accessToken = auth?.tokens?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    if (auth?.auth_mode === 'api_key' || auth?.OPENAI_API_KEY || process.env.OPENAI_API_KEY) {
      return { status: 'unavailable', detail: 'Codex uses an API key here, which has no plan limits.' };
    }
    return { status: 'signed-out', detail: 'Sign in to Codex with your ChatGPT account to see live limits.' };
  }
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (typeof auth?.tokens?.account_id === 'string' && auth.tokens.account_id) {
    headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
  }
  try {
    const response = await fetchJson('https://chatgpt.com/backend-api/wham/usage', { headers });
    if (response.status === 401) {
      return { status: 'expired', detail: "Codex's sign-in has expired. Run a Codex turn to renew it, then refresh." };
    }
    if (!response.ok) {
      const message = typeof response.body?.detail === 'string' ? response.body.detail : response.body?.error?.message;
      return { status: 'error', detail: message || `HTTP ${response.status}` };
    }
    return codexLimitsFromWhamUsage(response.body) ?? { status: 'unavailable', detail: 'Codex reported no plan limits.' };
  } catch (error) {
    return { status: 'error', detail: error?.message || String(error) };
  }
};

// --- cache -------------------------------------------------------------------

const cache = new Map();
const inFlight = new Map();
let codexReader = async () => null;
const readers = {
  claude: readClaudeLimits,
  codex: async () => (await codexReader()) ?? (await readCodexWhamLimits()),
  antigravity: readAntigravityLimits,
  grok: readGrokLimits,
};

/** Lets main.js hand over the shared Codex app-server without importing Electron here. */
export const configureCodexLiveLimits = (manager, clientVersion) => {
  codexReader = () => readCodexLiveLimits(manager, clientVersion);
};

const readOnce = (providerId) => {
  if (!inFlight.has(providerId)) {
    const pending = readers[providerId]()
      .catch((error) => ({ status: 'error', detail: error?.message || String(error) }))
      .then((report) => {
        const stamped = { ...report, at: Date.now() };
        cache.set(providerId, stamped);
        return stamped;
      })
      .finally(() => inFlight.delete(providerId));
    inFlight.set(providerId, pending);
  }
  return inFlight.get(providerId);
};

/** Forget cached reports (a provider's sign-in changed). */
export const clearProviderUsageLimitsCache = (providerIds = Object.keys(readers)) => {
  for (const providerId of providerIds) cache.delete(providerId);
};

/** `{ antigravity, grok, codex }` reports (`at` = when read); cached for a minute unless forced. */
export const readProviderUsageLimits = async ({ force = false, providers } = {}) =>
  Object.fromEntries(
    await Promise.all(
      Object.keys(readers).filter((providerId) => !Array.isArray(providers) || providers.includes(providerId)).map(async (providerId) => {
        const cached = cache.get(providerId);
        if (!force && cached && Date.now() - cached.at < CACHE_MS) return [providerId, cached];
        return [providerId, await readOnce(providerId)];
      })
    )
  );
