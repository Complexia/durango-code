import { DEFAULT_PACKAGED_WEB_URL, isSameWebOrigin } from './web-origin.js';

// Durango (durango.sh) access for the desktop: a scoped `dgo_` API key minted
// with the desktop session (/api/desktop-auth/durango-key, contracts.md §8)
// and a small client for the Durango public API (/api/v1, contracts.md §7):
// chats/memory, Durango Tasks, and the dispatch endpoints the Durango Chat
// dispatch worker polls. Both live on the desktop's web origin (web-origin.js).
//
// The key is a device credential like the repository token: only the main
// process ever sees it, it is stored next to the account session (safeStorage
// in packaged builds), sign-in replaces it, and sign-out revokes and wipes it.
// Nothing here runs on its own (the only background caller is the opt-in
// dispatch worker, src/main/durango-dispatch.js), and every failure surfaces
// as a typed DurangoError.

export const DEFAULT_DURANGO_URL = DEFAULT_PACKAGED_WEB_URL;
export const DURANGO_REQUEST_TIMEOUT_MS = 15_000;
const MINT_TIMEOUT_MS = 20_000;
const REVOKE_TIMEOUT_MS = 10_000;
// Durango allows 10 mints per user per hour (429 + Retry-After).
// After a failed mint, callers get the same error without a new request until
// the cooldown ends, so nothing (startup warm-up, tool calls, @chat search)
// can re-mint in a loop.
const MINT_RATE_LIMIT_FALLBACK_MS = 10 * 60 * 1000;
const MINT_FAILURE_COOLDOWN_MS = 60 * 1000;
const MINT_NETWORK_COOLDOWN_MS = 15 * 1000;

const retryAfterMs = (response) => {
  const header = response.headers?.get?.('retry-after');
  if (!header) return MINT_RATE_LIMIT_FALLBACK_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60 * 60 * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 60 * 60 * 1000) : MINT_RATE_LIMIT_FALLBACK_MS;
};

/**
 * Error codes:
 * - `not_signed_in`: no desktop account session (or it expired / was revoked).
 * - `not_connected`: signed in, but no usable Durango key (Durango cannot
 *   mint one yet, or rejects the device's key).
 * - `network`: Durango is unreachable or timed out.
 * - `api`: Durango answered with an error (bad request, not found, …).
 */
export class DurangoError extends Error {
  constructor(code, message, { status = null, apiCode = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DurangoError';
    this.code = code;
    this.status = status;
    // Durango's machine-readable `error.code` (`stale_link`,
    // `machine_not_registered`, `invalid_transition`, …) when it sent one.
    this.apiCode = apiCode;
  }
}

const notSignedIn = () =>
  new DurangoError('not_signed_in', 'Sign in to your Durango account in Durango Code to use Durango Chat.');

const isTimeout = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

const networkError = (what, error) =>
  new DurangoError(
    'network',
    isTimeout(error) ? `${what} timed out.` : `Could not reach ${what} (${error?.message ?? error}).`,
    { cause: error }
  );

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

// Durango's /api/v1 envelope is `{ error: { message, type, code } }`; the
// desktop-auth routes answer `{ error: "message" }`. Accept both.
const errorMessageFrom = (data) => {
  if (typeof data?.error === 'string') return data.error;
  if (typeof data?.error?.message === 'string') return data.error.message;
  return null;
};
const errorCodeFrom = (data) =>
  typeof data?.error?.code === 'string' ? data.error.code : typeof data?.code === 'string' ? data.code : null;

/** Origin of the desktop's web URL; the Durango API is served from it. */
export const resolveDurangoBaseUrl = (webOrigin) => {
  try {
    return new URL(String(webOrigin)).origin;
  } catch {
    return DEFAULT_DURANGO_URL;
  }
};

/**
 * The device's Durango key. `get()` returns the stored key or mints one with
 * the desktop session; `refresh(keyId)` re-mints after Durango rejected that
 * key; `clear()` wipes it locally and (optionally) revokes it remotely.
 */
export const createDurangoCredentials = ({
  readSession,
  readStored,
  writeStored,
  removeStored,
  webOrigin,
  deviceName,
  getDeviceId = async () => null,
  fetchImpl = fetch,
  now = () => Date.now(),
}) => {
  let generation = 0;
  let cached = null;
  let pending = null;
  let mintBlocked = null; // { until, error }
  let storageQueue = Promise.resolve();
  const serialize = (operation) => {
    const next = storageQueue.then(operation, operation);
    storageQueue = next.catch(() => {});
    return next;
  };
  const changed = () => new DurangoError('not_signed_in', 'The Durango account changed. Try again.');

  const withBaseUrl = (stored) => ({ ...stored, baseUrl: resolveDurangoBaseUrl(webOrigin()) });

  const revoke = async (credential, session) => {
    if (!credential?.keyId || !session?.token) return;
    try {
      await fetchImpl(new URL('/api/desktop-auth/durango-key', credential.origin ?? webOrigin()), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ keyId: credential.keyId }),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      // Best effort: local sign-out must work offline. The key stays listed
      // (and revocable) under Durango → Settings → API keys.
    }
  };

  const blockMinting = (version, error, ms) => {
    if (version === generation) mintBlocked = { until: now() + ms, error };
    return error;
  };

  const mint = async (version) => {
    const session = await readSession();
    if (!session?.token) throw notSignedIn();
    if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) throw notSignedIn();
    if (mintBlocked && now() < mintBlocked.until) throw mintBlocked.error;
    mintBlocked = null;
    const base = new URL(webOrigin()).origin;
    const deviceId = await Promise.resolve(getDeviceId()).catch(() => null);
    let response;
    try {
      // Durango labels the key "Durango Code · <deviceName>" (contracts §8).
      response = await fetchImpl(new URL('/api/desktop-auth/durango-key', base), {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(deviceName ? { deviceName } : {}),
          ...(deviceId ? { deviceId } : {}),
        }),
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      throw blockMinting(version, networkError('Durango', error), MINT_NETWORK_COOLDOWN_MS);
    }
    const data = await readJson(response);
    if (response.status === 401) throw notSignedIn();
    if (response.status === 429) {
      const wait = retryAfterMs(response);
      throw blockMinting(
        version,
        new DurangoError(
          'not_connected',
          `Too many Durango connection attempts from this account; try again in ${Math.max(1, Math.ceil(wait / 60_000))} min.`,
          { status: 429 }
        ),
        wait
      );
    }
    if (!response.ok) {
      throw blockMinting(
        version,
        new DurangoError(
          'not_connected',
          response.status === 404
            ? 'Durango cannot connect this device to Durango Chat yet.'
            : response.status === 503 && /not_configured/.test(JSON.stringify(data ?? ''))
              ? 'the Durango Chat connection is not enabled on Durango yet.'
              : errorMessageFrom(data) || `Could not connect Durango Code to Durango Chat (${response.status}).`,
          { status: response.status }
        ),
        MINT_FAILURE_COOLDOWN_MS
      );
    }
    if (typeof data?.key !== 'string' || !/^dgo_\S+$/.test(data.key) || typeof data?.keyId !== 'string' || !data.keyId) {
      throw new DurangoError('not_connected', 'Durango returned an invalid Durango key.');
    }
    const credential = {
      origin: base,
      key: data.key,
      keyId: data.keyId,
      createdAt: new Date().toISOString(),
    };
    await serialize(async () => {
      if (version !== generation) {
        void revoke(credential, session);
        throw changed();
      }
      await writeStored(credential);
      if (version !== generation) {
        void revoke(credential, session);
        throw changed();
      }
      cached = credential;
    });
    return credential;
  };

  const get = () => {
    if (pending) return pending;
    const version = generation;
    const operation = (async () => {
      const stored = cached ?? (await serialize(readStored));
      if (version !== generation) throw changed();
      // A key minted through a retired origin (code.durango.sh) is still
      // valid on durango.sh, so it is reused (web-origin.js).
      if (stored?.key && stored?.keyId && isSameWebOrigin(stored.origin, new URL(webOrigin()).origin)) {
        cached = stored;
        return withBaseUrl(stored);
      }
      return withBaseUrl(await mint(version));
    })();
    pending = operation;
    void operation.finally(() => {
      if (pending === operation) pending = null;
    }).catch(() => {});
    return operation;
  };

  /** Durango rejected `keyId` (401): forget it and mint a replacement once. */
  const refresh = async (keyId) => {
    const version = generation;
    await serialize(async () => {
      const stored = cached ?? (await readStored());
      if (stored?.keyId && stored.keyId !== keyId) return; // Already replaced.
      cached = null;
      await removeStored();
    });
    if (version !== generation) throw changed();
    return get();
  };

  /**
   * Sign-out / account switch. `session` is the session to authorize the
   * remote revoke with — capture it before the account session is dropped.
   */
  const clear = ({ revokeRemote = false, session = null } = {}) => {
    generation += 1;
    pending = null;
    mintBlocked = null;
    const previous = cached;
    cached = null;
    return serialize(async () => {
      const stored = previous ?? (await readStored().catch(() => null));
      const revokeSession = session ?? (revokeRemote ? await readSession().catch(() => null) : null);
      await removeStored();
      if (revokeRemote) void revoke(stored, revokeSession);
    });
  };

  /** Non-minting peek for status displays. */
  const peek = async () => {
    const stored = cached ?? (await serialize(readStored).catch(() => null));
    return stored?.key ? withBaseUrl(stored) : null;
  };

  return { get, refresh, clear, peek };
};

// ---------------------------------------------------------------------------
// Public API client

const clampInt = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
};

const str = (value) => (typeof value === 'string' ? value : '');

const normalizeChat = (chat) => ({
  id: str(chat?.id),
  projectId: typeof chat?.projectId === 'string' ? chat.projectId : null,
  title: str(chat?.title).trim() || 'Untitled chat',
  updatedAt: typeof chat?.updatedAt === 'string' || typeof chat?.updatedAt === 'number' ? chat.updatedAt : null,
  snippet: str(chat?.snippet),
  url: typeof chat?.url === 'string' ? chat.url : null,
  ...(chat?.archived === true ? { archived: true } : {}),
});

// Chat links seen in search results (any caller: composer, agents), so an
// @chat reference written later can open the exact chat URL. Bounded LRU.
const KNOWN_CHAT_URLS_LIMIT = 1_000;
const createChatUrlMemory = () => {
  const urls = new Map();
  return {
    record(chats) {
      for (const chat of chats) {
        if (!chat.id || !chat.url) continue;
        urls.delete(chat.id);
        urls.set(chat.id, chat.url);
      }
      while (urls.size > KNOWN_CHAT_URLS_LIMIT) urls.delete(urls.keys().next().value);
    },
    get: (chatId) => urls.get(chatId) ?? null,
  };
};

const normalizeMessage = (message) => ({
  id: str(message?.id),
  role: message?.role === 'user' ? 'user' : 'assistant',
  content: str(message?.content),
  createdAt: typeof message?.createdAt === 'string' || typeof message?.createdAt === 'number' ? message.createdAt : null,
});

const normalizeFact = (fact) => ({
  id: str(fact?.id),
  text: str(fact?.text),
  kind: typeof fact?.kind === 'string' ? fact.kind : null,
  source: fact?.source === 'code' ? 'code' : 'chat',
});

// Long-poll claims wait up to 25 s on the server (contracts §7); allow for
// the round trip on top.
export const DISPATCH_CLAIM_WAIT_MS = 25_000;
const DISPATCH_CLAIM_TIMEOUT_MS = DISPATCH_CLAIM_WAIT_MS + 15_000;
const ATTACHMENT_TIMEOUT_MS = 60_000;

// An account connector (durango.sh Settings → Connectors) as an MCP server.
// Only Durango's connector proxy path is accepted, rebuilt on the origin this
// device's key belongs to: the key rides along as the server's Authorization
// header and must never go anywhere else (or be lost to a host alias).
const CONNECTOR_PROXY_PATH = /^\/api\/v1\/connectors\/[A-Za-z0-9_-]{1,64}\/mcp$/;
const normalizeConnector = (connector, baseUrl) => {
  const serverName = str(connector?.serverName).trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(serverName)) return null;
  let pathname;
  try {
    pathname = new URL(str(connector?.url)).pathname;
  } catch {
    return null;
  }
  if (!CONNECTOR_PROXY_PATH.test(pathname)) return null;
  return {
    id: str(connector.id),
    kind: str(connector.kind) || 'custom',
    name: str(connector.name) || serverName,
    serverName,
    url: new URL(pathname, baseUrl).toString(),
  };
};

const normalizeDispatch = (dispatch) => {
  if (!dispatch || typeof dispatch !== 'object' || typeof dispatch.id !== 'string' || !dispatch.id) return null;
  const project = dispatch.project && typeof dispatch.project === 'object' ? dispatch.project : {};
  const optional = (value) => (typeof value === 'string' && value.trim() ? value : null);
  const source = dispatch.sourceChat && typeof dispatch.sourceChat === 'object' ? dispatch.sourceChat : null;
  return {
    id: dispatch.id,
    origin: dispatch.origin === 'tasks' || dispatch.origin === 'api' ? dispatch.origin : 'chat',
    prompt: str(dispatch.prompt),
    taskId: optional(dispatch.taskId),
    taskUrl: optional(dispatch.taskUrl),
    project: { id: optional(project.id), name: optional(project.name), repoId: optional(project.repoId) },
    modelId: optional(dispatch.modelId),
    accessMode: dispatch.accessMode === 'ask' || dispatch.accessMode === 'auto-edit' ? dispatch.accessMode : null,
    sourceChat:
      source && typeof source.threadId === 'string'
        ? { threadId: source.threadId, messageId: optional(source.messageId), url: optional(source.url) }
        : null,
    /** Follow-up: continue this thread instead of starting one. */
    threadId: optional(dispatch.threadId),
    /** Who started an `api` run (the API key's name, e.g. "Grok (MCP)"). */
    sourceLabel: optional(dispatch.sourceLabel),
    createdAt: optional(dispatch.createdAt),
  };
};

export const createDurangoClient = ({
  credentials,
  readSession,
  fetchImpl = fetch,
  timeoutMs = DURANGO_REQUEST_TIMEOUT_MS,
  isPackaged = () => false,
  webOrigin = () => DEFAULT_DURANGO_URL,
}) => {
  const chatUrls = createChatUrlMemory();
  const request = async (method, apiPath, { query, body, timeout = timeoutMs, signal, headers: extraHeaders } = {}) => {
    const session = await readSession();
    if (!session?.token) throw notSignedIn();
    let credential = await credentials.get();
    for (let attempt = 0; ; attempt += 1) {
      const url = new URL(`/api/v1${apiPath}`, credential.baseUrl);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
      let response;
      try {
        const timeoutSignal = AbortSignal.timeout(timeout);
        response = await fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${credential.key}`,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(extraHeaders ?? {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
          redirect: 'error',
        });
      } catch (error) {
        throw networkError('Durango', error);
      }
      const data = await readJson(response);
      if (response.status === 401) {
        // The key was revoked (for example from Durango's API keys page) or
        // expired: re-mint once with the desktop session, then give up.
        if (attempt === 0) {
          credential = await credentials.refresh(credential.keyId);
          continue;
        }
        throw new DurangoError('not_connected', 'Durango rejected this device\'s key. Sign out and back in to reconnect.', {
          status: 401,
        });
      }
      if (!response.ok) {
        throw new DurangoError(
          'api',
          errorMessageFrom(data) || `Durango request failed (${response.status}).`,
          { status: response.status, apiCode: errorCodeFrom(data) }
        );
      }
      return data ?? {};
    }
  };

  const taskPath = (taskId) => {
    const id = str(taskId).trim();
    if (!id) throw new DurangoError('api', 'A task id is required.');
    return `/tasks/${encodeURIComponent(id)}`;
  };

  const baseUrl = async () => {
    const credential = await credentials.peek().catch(() => null);
    return credential?.baseUrl ?? resolveDurangoBaseUrl(webOrigin());
  };

  return {
    /** Durango origin for links (`/tasks`, chats); never mints a key. */
    baseUrl,
    // --- Durango Tasks (contracts §7) -----------------------------------------
    async listTasks({ status, projectName, q } = {}) {
      const data = await request('GET', '/tasks', { query: { status, projectName, q } });
      return {
        columns: Array.isArray(data.columns) ? data.columns : [],
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
      };
    },
    /** `taskId` may be a Durango task id or a pre-migration Durango Code board id. */
    async getTask(taskId) {
      const data = await request('GET', taskPath(taskId));
      return { task: data.task ?? null };
    },
    /** `{ action: "link" | "unlink" | "thread-status", ... }` → `{ task }`; a stale link is a 409. */
    async taskAction(taskId, body) {
      const data = await request('POST', taskPath(taskId), { body });
      return { task: data.task ?? null };
    },
    /**
     * Bytes of one task attachment: the short-lived `url` Durango returned
     * with the task (no credentials sent), else the API download route with
     * this device's key (307 to a fresh URL).
     */
    async downloadTaskAttachment(taskId, attachment) {
      const direct = typeof attachment?.url === 'string' ? attachment.url : null;
      let target = null;
      if (direct) {
        try {
          const url = new URL(direct);
          if (url.protocol === 'https:' || (!isPackaged() && url.protocol === 'http:')) target = url;
        } catch {}
      }
      let response;
      if (target) {
        try {
          response = await fetchImpl(target, { signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS) });
        } catch (error) {
          throw networkError('Durango', error);
        }
        if (response.ok) return Buffer.from(await response.arrayBuffer());
        // An expired presigned URL: fall back to the API route below.
      }
      const session = await readSession();
      if (!session?.token) throw notSignedIn();
      const credential = await credentials.get();
      const url = new URL(
        `/api/v1${taskPath(taskId)}/attachments/${encodeURIComponent(str(attachment?.id))}`,
        credential.baseUrl
      );
      try {
        // fetch drops the Authorization header on the cross-origin redirect
        // to storage, so the key never reaches the object store.
        response = await fetchImpl(url, {
          headers: { authorization: `Bearer ${credential.key}` },
          signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS),
        });
      } catch (error) {
        throw networkError('Durango', error);
      }
      if (!response.ok) {
        throw new DurangoError('api', `Attachment download failed (${response.status}).`, { status: response.status });
      }
      return Buffer.from(await response.arrayBuffer());
    },
    // --- Dispatch: agents started from Durango Chat (contracts §7) -----------
    async registerMachine({ machineId, name, platform, projects, capabilities }) {
      await request('POST', '/code/machines', {
        body: {
          machineId,
          name,
          platform,
          projects: (projects ?? []).map((project) => ({
            id: project.id,
            name: project.name,
            repoId: project.repoId ?? null,
          })),
          ...(Array.isArray(capabilities) ? { capabilities } : {}),
        },
      });
      return { ok: true };
    },
    /** Long-poll for the next dispatch for this machine; `{ dispatch: null }` when none arrived. */
    async claimDispatch({ machineId, waitMs = DISPATCH_CLAIM_WAIT_MS, signal } = {}) {
      const wait = clampInt(waitMs, 0, DISPATCH_CLAIM_WAIT_MS, DISPATCH_CLAIM_WAIT_MS);
      const data = await request('POST', '/code/dispatches/claim', {
        body: { machineId, waitMs: wait },
        timeout: wait + (DISPATCH_CLAIM_TIMEOUT_MS - DISPATCH_CLAIM_WAIT_MS),
        signal,
      });
      return { dispatch: normalizeDispatch(data.dispatch) };
    },
    /** `{ status, codeThreadId?, summary?, error?, machineId? }`; 409 = cancelled from chat or already settled. */
    async reportDispatch(dispatchId, report) {
      const id = str(dispatchId).trim();
      if (!id) throw new DurangoError('api', 'A dispatch id is required.');
      await request('POST', `/code/dispatches/${encodeURIComponent(id)}`, { body: report });
      return { ok: true };
    },
    async searchChats(q, { limit, cursor } = {}) {
      const data = await request('GET', '/chats', {
        query: { q: str(q).trim(), limit: clampInt(limit, 1, 50, 20), cursor },
      });
      const chats = (Array.isArray(data.data) ? data.data : []).map(normalizeChat).filter((chat) => chat.id);
      chatUrls.record(chats);
      return {
        data: chats,
        nextCursor: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null,
      };
    },
    /** Best URL for a chat: one Durango returned for it, else Durango's by-id redirect (`/c/<chatId>`). */
    async chatUrl(chatId) {
      const known = chatUrls.get(chatId);
      if (known) return known;
      const credential = await credentials.peek().catch(() => null);
      const base = credential?.baseUrl ?? resolveDurangoBaseUrl(webOrigin());
      const id = str(chatId).trim();
      return new URL(id ? `/c/${encodeURIComponent(id)}` : '/chats', base).toString();
    },
    async readChat(chatId, { cursor, limit } = {}) {
      const id = str(chatId).trim();
      if (!id) throw new DurangoError('api', 'A chat id is required.');
      const data = await request('GET', `/chats/${encodeURIComponent(id)}/messages`, {
        query: { cursor, limit: clampInt(limit, 1, 100, 30) },
      });
      return {
        data: (Array.isArray(data.data) ? data.data : []).map(normalizeMessage),
        nextCursor: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null,
        total: Number.isFinite(Number(data.total)) ? Number(data.total) : null,
      };
    },
    /**
     * The account's connectors as MCP servers, plus the Authorization header
     * that reaches them (this device's key; durango.sh holds the upstream
     * credentials).
     */
    async listConnectors({ timeout } = {}) {
      const data = await request('GET', '/connectors', timeout ? { timeout } : {});
      const credential = await credentials.get();
      return {
        connectors: (Array.isArray(data.connectors) ? data.connectors : [])
          .map((connector) => normalizeConnector(connector, credential.baseUrl))
          .filter(Boolean),
        authorization: `Bearer ${credential.key}`,
      };
    },
    async recallMemory(query) {
      const data = await request('POST', '/memory/recall', { body: { query: str(query).trim() } });
      return { facts: (Array.isArray(data.facts) ? data.facts : []).map(normalizeFact).filter((fact) => fact.text) };
    },
    async remember(fact) {
      const text = str(fact).trim();
      if (!text) throw new DurangoError('api', 'A non-empty fact is required.');
      const data = await request('POST', '/memory/remember', { body: { fact: text } });
      return { id: str(data.id) };
    },
  };
};

// ---------------------------------------------------------------------------
// DURANGO_MOCK=1: fixture client for development, GUI verification and tests.
// Never talks to the network and needs no account.

const MOCK_CHATS = [
  {
    id: 'jd7mockchat0001billingrewrite',
    projectId: 'mockproject01',
    title: 'Billing rewrite plan',
    updatedAt: '2026-10-12T16:20:00.000Z',
    snippet: 'Move metered usage to credits, keep Stripe only for top-ups…',
    url: 'https://durango.sh/chats/mockproject01?node=jd7mockchat0001billingrewrite',
  },
  {
    id: 'jd7mockchat0002futuremaildeploy',
    projectId: 'mockproject01',
    title: 'futuremail deploy checklist',
    updatedAt: '2026-10-11T09:05:00.000Z',
    snippet: 'Railway service, pnpm build, run migrations before switching traffic.',
    url: 'https://durango.sh/chats/mockproject01?node=jd7mockchat0002futuremaildeploy',
  },
  {
    id: 'jd7mockchat0003onboardingcopy',
    projectId: 'mockproject02',
    title: 'Onboarding copy ideas',
    updatedAt: '2026-10-02T13:45:00.000Z',
    snippet: 'Short, friendly, no exclamation marks. Lead with the outcome.',
    url: 'https://durango.sh/chats/mockproject02?node=jd7mockchat0003onboardingcopy',
  },
];

const MOCK_MESSAGES = {
  jd7mockchat0001billingrewrite: [
    { id: 'm1', role: 'user', content: 'Plan the billing rewrite: credits for usage, Stripe only for top-ups.', createdAt: '2026-10-12T16:00:00.000Z' },
    { id: 'm2', role: 'assistant', content: 'Phase 1: ledger table. Phase 2: metering. Phase 3: migrate plans.', createdAt: '2026-10-12T16:20:00.000Z' },
  ],
};

const MOCK_TASK_COLUMNS = [
  { id: 'col_todo', name: 'To do', title: 'To do', role: 'todo', position: 0 },
  { id: 'col_progress', name: 'In progress', title: 'In progress', role: 'in_progress', position: 1 },
  { id: 'col_review', name: 'In review', title: 'In review', role: 'review', position: 2 },
  { id: 'col_done', name: 'Done', title: 'Done', role: 'done', position: 3 },
];

const mockTask = (id, columnId, title, description, extra = {}) => ({
  id,
  columnId,
  title,
  description,
  position: 0,
  attachments: [],
  agentNotes: null,
  linked: null,
  createdAt: '2026-10-10T09:00:00.000Z',
  updatedAt: '2026-10-12T09:00:00.000Z',
  status: MOCK_TASK_COLUMNS.find((column) => column.id === columnId)?.role ?? null,
  labels: [],
  priority: null,
  projectName: null,
  repoId: null,
  prUrl: null,
  isDraft: false,
  source: { kind: 'chat' },
  legacyId: null,
  url: `${DEFAULT_DURANGO_URL}/tasks?task=${id}`,
  ...extra,
});

const MOCK_THREAD_COLUMN = { running: 'col_progress', finished: 'col_review', done: 'col_done' };

export const createMockDurangoClient = ({ dispatchDelayMs = 4_000 } = {}) => {
  const remembered = [];
  const tasks = [
    mockTask('mock_task_1', 'col_todo', 'Fix the futuremail signup bug', 'Signup fails when the email has a plus sign.', {
      projectName: 'futuremail',
      legacyId: 'orion_task_legacy_1',
    }),
    mockTask('mock_task_2', 'col_todo', 'Write the billing migration', 'Move metered usage to credits.'),
    mockTask('mock_task_3', 'col_progress', 'Onboarding copy pass', 'Short, friendly, no exclamation marks.'),
  ];
  const findTask = (taskId) => tasks.find((task) => task.id === taskId || task.legacyId === taskId) ?? null;
  const machines = new Map();
  // One fake dispatch per process (DURANGO_MOCK=1): offered to the first
  // registered machine a few seconds after it starts polling.
  let mockDispatch = { offered: false, firstClaimAt: null };
  const reports = [];
  const waitFor = (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  return {
    mock: true,
    reports,
    async baseUrl() {
      return DEFAULT_DURANGO_URL;
    },
    async listTasks() {
      return { columns: MOCK_TASK_COLUMNS, tasks: tasks.map((task) => ({ ...task })) };
    },
    async getTask(taskId) {
      const task = findTask(taskId);
      if (!task) throw new DurangoError('api', 'Task not found.', { status: 404, apiCode: 'task_not_found' });
      return { task: { ...task } };
    },
    async taskAction(taskId, body) {
      const task = findTask(taskId);
      if (!task) throw new DurangoError('api', 'Task not found.', { status: 404, apiCode: 'task_not_found' });
      const stale = () => new DurangoError('api', 'Thread is not linked to this task.', { status: 409, apiCode: 'stale_link' });
      if (body?.action === 'link') {
        task.linked = {
          threadId: str(body.threadId),
          threadTitle: body.threadTitle ?? null,
          projectName: body.projectName ?? null,
          status: 'idle',
          linkedAt: new Date().toISOString(),
        };
        task.agentNotes = null;
      } else if (body?.action === 'unlink') {
        if (body.threadId && task.linked && task.linked.threadId !== body.threadId) throw stale();
        task.linked = null;
      } else if (body?.action === 'thread-status') {
        if (!task.linked || task.linked.threadId !== body.threadId) throw stale();
        task.linked.status = str(body.status);
        if (MOCK_THREAD_COLUMN[body.status]) task.columnId = MOCK_THREAD_COLUMN[body.status];
        if (body.status === 'finished' && typeof body.agentNotes === 'string') task.agentNotes = body.agentNotes;
      } else {
        throw new DurangoError('api', 'Unknown action.', { status: 400, apiCode: 'invalid_request' });
      }
      task.updatedAt = new Date().toISOString();
      return { task: { ...task } };
    },
    async downloadTaskAttachment() {
      return Buffer.from('mock attachment');
    },
    async registerMachine(machine) {
      machines.set(machine.machineId, machine);
      return { ok: true };
    },
    async claimDispatch({ machineId, waitMs = DISPATCH_CLAIM_WAIT_MS, signal } = {}) {
      const machine = machines.get(machineId);
      if (!machine) {
        throw new DurangoError('api', 'Register this machine with POST /api/v1/code/machines first.', {
          status: 404,
          apiCode: 'machine_not_registered',
        });
      }
      mockDispatch.firstClaimAt ??= Date.now();
      const project = machine.projects?.[0] ?? null;
      if (!mockDispatch.offered && project) {
        const wait = Math.max(0, mockDispatch.firstClaimAt + dispatchDelayMs - Date.now());
        await waitFor(Math.min(wait, waitMs), signal);
        if (!signal?.aborted && Date.now() >= mockDispatch.firstClaimAt + dispatchDelayMs) {
          mockDispatch.offered = true;
          return {
            dispatch: normalizeDispatch({
              id: 'mock_dispatch_1',
              prompt: 'Look around this project and summarize what it does in three bullet points. Do not change any files.',
              taskId: 'mock_task_1',
              project: { id: project.id, name: project.name, repoId: project.repoId ?? null },
              modelId: null,
              accessMode: 'ask',
              sourceChat: { threadId: 'mockchat01', messageId: 'm1', url: `${DEFAULT_DURANGO_URL}/c/mockchat01` },
              createdAt: new Date().toISOString(),
            }),
          };
        }
        return { dispatch: null };
      }
      await waitFor(Math.min(waitMs, 25_000), signal);
      return { dispatch: null };
    },
    async reportDispatch(dispatchId, report) {
      reports.push({ dispatchId, ...report });
      console.log(`[durango mock] dispatch ${dispatchId} → ${report?.status}${report?.error ? ` (${report.error})` : ''}`);
      return { ok: true };
    },
    async chatUrl(chatId) {
      return MOCK_CHATS.find((chat) => chat.id === chatId)?.url ?? `${DEFAULT_DURANGO_URL}/chats`;
    },
    async searchChats(q, { limit } = {}) {
      const query = str(q).trim().toLowerCase();
      const data = MOCK_CHATS.filter(
        (chat) => !query || chat.title.toLowerCase().includes(query) || chat.snippet.toLowerCase().includes(query)
      ).slice(0, clampInt(limit, 1, 50, 20));
      return { data: data.map(normalizeChat), nextCursor: null };
    },
    async readChat(chatId) {
      const id = str(chatId).trim();
      if (!MOCK_CHATS.some((chat) => chat.id === id)) {
        throw new DurangoError('api', `Chat ${id} was not found.`, { status: 404 });
      }
      const data = (MOCK_MESSAGES[id] ?? [
        { id: 'm1', role: 'user', content: 'Mock chat message.', createdAt: '2026-10-01T00:00:00.000Z' },
      ]).map(normalizeMessage);
      return { data, nextCursor: null, total: data.length };
    },
    async listConnectors() {
      return { connectors: [], authorization: 'Bearer dgo_mock' };
    },
    async recallMemory() {
      return {
        facts: [
          { id: 'f1', text: 'Prefers bun over npm and yarn.', kind: 'preference', source: 'chat' },
          { id: 'f2', text: 'futuremail deploys on Railway.', kind: 'fact', source: 'code' },
          ...remembered,
        ],
      };
    },
    async remember(fact) {
      const id = `mock-fact-${remembered.length + 1}`;
      remembered.push({ id, text: str(fact).trim(), kind: 'fact', source: 'code' });
      return { id };
    },
  };
};
