// Plan limits read live from the providers' own quota endpoints, with the
// sign-in their CLI already stored (the Usage view's Limits tab). Claude
// limits arrive during runs (usage-limits.js) and Codex limits from its
// session logs (usage-stats.js); Antigravity and Grok record none locally,
// so they are asked directly, the way T3 Code reads them
// (apps/server/src/provider/antigravityUsageLimits.ts,
// packages/provider-grok/src/server/usageLimits.ts). Nothing is refreshed or
// written: an expired token reads as "run a turn to renew it".

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
  let raw = null;
  if (process.platform === 'darwin') {
    raw = await execText('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w']);
  } else if (process.platform === 'linux') {
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
    return { status: 'signed-out', detail: process.platform === 'win32' ? "Reading Antigravity's sign-in isn't supported on Windows yet." : 'Sign in to Antigravity to see its limits.' };
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

// --- cache -------------------------------------------------------------------

const cache = new Map();
const inFlight = new Map();
let codexReader = async () => null;
const readers = {
  antigravity: readAntigravityLimits,
  grok: readGrokLimits,
  codex: async () => (await codexReader()) ?? { status: 'unavailable' },
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
