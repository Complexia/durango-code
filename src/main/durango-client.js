import { appendFileSync, readFileSync } from 'node:fs';
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

/** The models a bot can be set to (GET /api/v1/bots modelChoices / modelCatalog), or null when Durango sent none. */
const normalizeBotModelChoices = (value, maxCount = 30) => {
  if (!Array.isArray(value)) return null;
  const choices = value
    .filter((choice) => choice && typeof choice.id === 'string' && choice.id && typeof choice.label === 'string')
    .slice(0, maxCount)
    .map((choice) => ({
      id: choice.id,
      label: choice.label,
      note: typeof choice.note === 'string' ? choice.note : '',
      claude: choice.claude === true,
      ...(typeof choice.provider === 'string' && choice.provider ? { provider: choice.provider } : {}),
      ...(typeof choice.lab === 'string' && choice.lab ? { lab: choice.lab } : {}),
      ...(typeof choice.recommended === 'boolean' ? { recommended: choice.recommended } : {}),
      ...(choice.legacy === true ? { legacy: true } : {}),
      ...(typeof choice.local === 'boolean' ? { local: choice.local } : {}),
      ...(Array.isArray(choice.efforts)
        ? { efforts: choice.efforts.filter((effort) => typeof effort === 'string' && effort).slice(0, 10) }
        : {}),
      ...(typeof choice.defaultEffort === 'string' && choice.defaultEffort ? { defaultEffort: choice.defaultEffort } : {}),
    }));
  return choices.length ? choices : null;
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
    /** Provider-agnostic effort ("low" … "max"); the renderer checks it against the turn's model. */
    reasoningEffort: optional(dispatch.reasoningEffort),
    accessMode: dispatch.accessMode === 'ask' || dispatch.accessMode === 'auto-edit' ? dispatch.accessMode : null,
    sourceChat:
      source && typeof source.threadId === 'string'
        ? { threadId: source.threadId, messageId: optional(source.messageId), url: optional(source.url) }
        : null,
    /** Follow-up: continue this thread instead of starting one. */
    threadId: optional(dispatch.threadId),
    /** Who started an `api` run (the API key's name, e.g. "Grok (MCP)"). */
    sourceLabel: optional(dispatch.sourceLabel),
    /** Started by one of the person's bots: its name. */
    bot: optional(dispatch.bot)?.slice(0, 80) ?? null,
    /** Started by one of the person's bots: its id. */
    botId: optional(dispatch.botId)?.slice(0, 128) ?? null,
    createdAt: optional(dispatch.createdAt),
  };
};

// --- Bot replies: a Durango bot's reply run on this machine's Claude Code ------------

export const BOT_LANE_DEFAULT_HEARTBEAT_MS = 10_000;
// Bot tools can take a while (searches, generations); the default 15 s is too short.
const BOT_TOOL_TIMEOUT_MS = 180_000;
const BOT_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const normalizeBotTool = (tool) => {
  const name = str(tool?.name).trim();
  if (!BOT_TOOL_NAME.test(name)) return null;
  return {
    name,
    description: str(tool?.description),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
  };
};

export const normalizeBotLane = (lane) => {
  if (!lane || typeof lane !== 'object') return null;
  const laneId = str(lane.laneId).trim();
  const botId = str(lane.botId).trim();
  if (!laneId || !botId) return null;
  const seen = new Set();
  const tools = [];
  for (const tool of Array.isArray(lane.tools) ? lane.tools : []) {
    const normalized = normalizeBotTool(tool);
    if (!normalized || seen.has(normalized.name)) continue;
    seen.add(normalized.name);
    tools.push(normalized);
  }
  return {
    laneId,
    botId,
    botName: str(lane.botName).trim() || 'Bot',
    threadId: str(lane.threadId),
    replyMessageId: str(lane.replyMessageId),
    /** Claude Code model id ("claude-opus-5-5"); null = Claude Code's default. */
    model: str(lane.model).trim() || null,
    /** The Durango model id the reply runs on ("openai/gpt-6.1-sol"): a non-Claude one runs on this machine's harness for it. */
    modelId: str(lane.modelId).trim() || null,
    /** Reasoning effort for Claude Code ("low" … "max"); null = CLI default. */
    reasoningEffort: str(lane.reasoningEffort).trim() || null,
    /** Appended to Claude Code's system prompt. */
    systemPrompt: str(lane.systemPrompt),
    prompt: str(lane.prompt),
    /** The conversation, structured (bot-sessions.js normalizeLaneSession): the machine keeps a session per bot. */
    ...(lane.session && typeof lane.session === 'object' ? { session: lane.session } : {}),
    tools,
    heartbeatMs: clampInt(lane.heartbeatMs, 2_000, 60_000, BOT_LANE_DEFAULT_HEARTBEAT_MS),
    /** The reply goes out as messages (claim feature "reply-messages"): sendBotLaneMessage, then the final answer. */
    ...(lane.messages === true ? { messages: true } : {}),
    /** Files attached in the conversation: download links or local staged copies (saved for Claude Code). */
    attachments: (Array.isArray(lane.attachments) ? lane.attachments : [])
      .filter((item) => item && ((typeof item.url === 'string' && /^https:\/\//.test(item.url)) || (item.local === true && str(item.pendingId || item.id))))
      .slice(0, 10)
      .map((item) => ({
        id: str(item.id || item.pendingId),
        ...(str(item.pendingId) ? { pendingId: str(item.pendingId) } : {}),
        name: str(item.name) || 'file',
        contentType: str(item.contentType),
        ...(typeof item.url === 'string' && /^https:\/\//.test(item.url) ? { url: item.url } : {}),
        ...(item.local === true ? { local: true } : {}),
      })),
  };
};

const BOT_INBOX_SOURCES = new Set(['person', 'routine', 'task', 'bot']);
export const normalizeBotInbox = (inbox) =>
  (Array.isArray(inbox) ? inbox : [])
    .filter((item) => item && typeof item === 'object' && typeof item.content === 'string')
    .map((item) => {
      const attachments = Array.isArray(item.attachments)
        ? item.attachments
            .filter((att) => att && typeof att === 'object' && typeof att.name === 'string' && att.name)
            .slice(0, 10)
            .map((att) => ({
              name: att.name,
              ...(str(att.pendingId) ? { pendingId: str(att.pendingId), id: str(att.pendingId) } : {}),
              ...(str(att.assetId) ? { assetId: str(att.assetId), ...(!str(att.pendingId) ? { id: str(att.assetId) } : {}) } : {}),
              ...(str(att.status) ? { status: str(att.status) } : {}),
              ...(str(att.machineId) ? { machineId: str(att.machineId) } : {}),
            }))
        : [];
      return {
        seq: Number.isFinite(Number(item.seq)) ? Number(item.seq) : null,
        source: BOT_INBOX_SOURCES.has(item.source) ? item.source : 'person',
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : null,
        content: item.content,
        ...(attachments.length ? { attachments } : {}),
      };
    });

const botLanePath = (laneId, action) => {
  const id = str(laneId).trim();
  if (!id) throw new DurangoError('api', 'A lane id is required.');
  return `/code/bots/lanes/${encodeURIComponent(id)}/${action}`;
};

/**
 * The account a desktop session belongs to (its user id, else its token), for
 * requests pinned to one account (`account` below): a sync started for one
 * account never sends to another, even across a key refresh.
 */
export const accountKeyOf = (session) =>
  session?.token ? (session.user?.id ? `user:${session.user.id}` : `token:${session.token}`) : null;

export const createDurangoClient = ({
  credentials,
  readSession,
  fetchImpl = fetch,
  timeoutMs = DURANGO_REQUEST_TIMEOUT_MS,
  isPackaged = () => false,
  webOrigin = () => DEFAULT_DURANGO_URL,
}) => {
  const chatUrls = createChatUrlMemory();
  // Advertised by GET /api/v1/bots (`pendingAttachments: true`): null until known.
  let pendingBotAttachmentsSupported = null;
  const request = async (method, apiPath, { query, body, form, timeout = timeoutMs, signal, headers: extraHeaders, account } = {}) => {
    const session = await readSession();
    if (!session?.token) throw notSignedIn();
    // Pinned to an account: checked again once the key is in hand (and after
    // a refresh), so a switch midway never sends this to the other account.
    const checkAccount = async () => {
      if (account && accountKeyOf(await readSession()) !== account) {
        throw new DurangoError('account_changed', 'The Durango account changed.');
      }
    };
    let credential = await credentials.get();
    await checkAccount();
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
          // `form` (multipart, e.g. a file) sets its own content type.
          ...(form !== undefined ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}),
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
          await checkAccount();
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

  // /api/v1 calls without a key (community themes): public reads, so installing
  // works signed out, and sharing without an account (`headers` carries the
  // device's anonymous theme owner key).
  const keylessRequest = async (method, apiPath, { query, body, timeout = timeoutMs, signal, headers: extraHeaders } = {}) => {
    const credential = await credentials.peek().catch(() => null);
    const url = new URL(`/api/v1${apiPath}`, credential?.baseUrl ?? resolveDurangoBaseUrl(webOrigin()));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(timeout);
      response = await fetchImpl(url, {
        method,
        headers: {
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
    if (!response.ok) {
      throw new DurangoError('api', errorMessageFrom(data) || `Durango request failed (${response.status}).`, {
        status: response.status,
        apiCode: errorCodeFrom(data),
      });
    }
    return data ?? {};
  };
  const publicGet = (apiPath, options) => keylessRequest('GET', apiPath, options);

  // Community theme writes: the signed-in account, or (`anonymousKey`) the
  // device's own owner key, for sharing without an account.
  const themeRequest = (method, apiPath, { anonymousKey, ...options } = {}) =>
    anonymousKey
      ? keylessRequest(method, apiPath, { ...options, headers: { 'x-durango-theme-owner': anonymousKey } })
      : request(method, apiPath, options);

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
    async registerMachine({ machineId, name, platform, projects, capabilities, models, modelsTruncated }) {
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
          ...(Array.isArray(models) ? { models } : {}),
          ...(modelsTruncated ? { modelsTruncated: true } : {}),
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
    /**
     * The dispatched thread (a bot's machine task) still runs but needs the
     * person or looks stuck: `{ machineId, codeThreadId?, notice: { kind, key, seq, detail } }`
     * → `{ ok, stale? }`. Its own route: a Durango without it answers 404, never a report.
     */
    async noticeDispatch(dispatchId, body) {
      const id = str(dispatchId).trim();
      if (!id) throw new DurangoError('api', 'A dispatch id is required.');
      const data = await request('POST', `/code/dispatches/${encodeURIComponent(id)}/notice`, { body });
      return { ok: data.ok === true, ...(data.stale === true ? { stale: true } : {}) };
    },
    // --- Bot replies on this machine's Claude Code (bot-replies.js) -----------
    /** Long-poll for a bot reply to run here; `{ lane: null }` when none arrived. Polling marks this machine available. */
    /** `machine`: `{ name, projects: string[], models: string[] }`, this machine's bot presence. */
    async claimBotLane({ machineId, platform, machine, ackStopTasks, ackSettleThreads, ackThreadActions, features, waitMs = DISPATCH_CLAIM_WAIT_MS, signal } = {}) {
      const wait = clampInt(waitMs, 0, DISPATCH_CLAIM_WAIT_MS, DISPATCH_CLAIM_WAIT_MS);
      const data = await request('POST', '/code/bots/claim', {
        body: {
          machineId,
          platform,
          ...(machine ? { machine } : {}),
          ...(ackStopTasks?.length ? { ackStopTasks } : {}),
          ...(ackSettleThreads?.length ? { ackSettleThreads } : {}),
          ...(ackThreadActions?.length ? { ackThreadActions } : {}),
          ...(features?.length ? { features } : {}),
          waitMs: wait,
        },
        timeout: wait + (DISPATCH_CLAIM_TIMEOUT_MS - DISPATCH_CLAIM_WAIT_MS),
        signal,
      });
      return {
        lane: normalizeBotLane(data.lane),
        // Cancelled bot tasks whose threads run here: stop them.
        stopTasks: Array.isArray(data.stopTasks) ? data.stopTasks.filter((id) => typeof id === 'string' && id).slice(0, 20) : [],
        // Legacy queued settles from Durango.
        settleThreads: Array.isArray(data.settleThreads) ? data.settleThreads.filter((id) => typeof id === 'string' && id).slice(0, 20) : [],
        // Thread actions a bot requested from elsewhere (manage_thread): run them if the thread is here.
        threadActions: Array.isArray(data.threadActions)
          ? data.threadActions
              .filter(
                (item) =>
                  item &&
                  typeof item === 'object' &&
                  typeof item.id === 'string' &&
                  item.id &&
                  typeof item.threadId === 'string' &&
                  item.threadId &&
                  typeof item.action === 'string' &&
                  item.action
              )
              .slice(0, 20)
              .map((item) => ({
                id: item.id,
                threadId: item.threadId,
                action: item.action,
                ...(typeof item.title === 'string' && item.title ? { title: item.title } : {}),
                ...(typeof item.modelId === 'string' && item.modelId ? { modelId: item.modelId } : {}),
                ...(typeof item.reasoningEffort === 'string' && item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
                ...(typeof item.accessMode === 'string' && item.accessMode ? { accessMode: item.accessMode } : {}),
                // answer_request: the card button to press for the person (answer_thread_request from elsewhere).
                ...(typeof item.answer === 'string' && item.answer ? { answer: item.answer } : {}),
                ...(typeof item.requestId === 'string' && item.requestId ? { requestId: item.requestId } : {}),
                ...(typeof item.reply === 'string' && item.reply ? { reply: item.reply } : {}),
                ...(typeof item.botName === 'string' && item.botName ? { botName: item.botName } : {}),
              }))
          : [],
        // Thread tools a bot's reply elsewhere (the cloud) runs here: list_threads,
        // read_thread, locate_thread, steer_thread, manage_thread, answer_thread_request.
        threadCalls: Array.isArray(data.threadCalls)
          ? data.threadCalls
              .filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && item.id && typeof item.tool === 'string' && item.tool)
              .slice(0, 10)
              .map((item) => ({
                id: item.id,
                tool: item.tool,
                input: item.input && typeof item.input === 'object' && !Array.isArray(item.input) ? item.input : {},
                botName: typeof item.botName === 'string' ? item.botName.slice(0, 80) : '',
                skipHosts: Array.isArray(item.skipHosts) ? item.skipHosts.filter((name) => typeof name === 'string').slice(0, 20) : [],
              }))
          : [],
        // The account has no bots: ask again only after this long.
        ...(Number.isFinite(data.idleMs) && data.idleMs > 0 ? { idleMs: Math.min(data.idleMs, 60 * 60_000) } : {}),
      };
    },
    /** `{ botId, machineId, text, activeTool?, takeInbox }` → `{ stop, inbox }`. */
    async reportBotLaneProgress({ laneId, signal, ...body } = {}) {
      const data = await request('POST', botLanePath(laneId, 'progress'), { body, signal });
      return { stop: data.stop === true, inbox: normalizeBotInbox(data.inbox) };
    },
    /**
     * One of a reply's messages before its final answer (the text it wrote
     * before a tool call): `{ botId, machineId, index, text, modelId? }` →
     * `{ ok, stop }` (`stop`: the reply was handed elsewhere; `ok` false: refused).
     */
    async sendBotLaneMessage({ laneId, signal, ...body } = {}) {
      const data = await request('POST', botLanePath(laneId, 'message'), { body, signal });
      return { ok: data.stop !== true && !data.refused, stop: data.stop === true };
    },
    /** `{ botId, machineId, name, input, toolCallId, message? }` → `{ result }` (`message`: the index of the message the call was made with). */
    async callBotLaneTool({ laneId, signal, ...body } = {}) {
      const data = await request('POST', botLanePath(laneId, 'tool'), { body, signal, timeout: BOT_TOOL_TIMEOUT_MS });
      return { result: data.result ?? null };
    },
    /** `{ botId, machineId, text, modelId?, failure?, retryElsewhere?, usage?, compact? }` → `{ ok, stored }`. */
    async finishBotLane({ laneId, signal, ...body } = {}) {
      const data = await request('POST', botLanePath(laneId, 'finish'), { body, signal });
      return { ok: data.ok !== false, stored: data.stored === true };
    },
    /** A task the reply runs as a Durango Code thread here: `{ botId, machineId, title, instructions }` → `{ taskId, title }`. */
    async createBotLaneTask({ laneId, signal, ...body } = {}) {
      const data = await request('POST', botLanePath(laneId, 'tasks'), { body, signal });
      if (!str(data.taskId)) throw new DurangoError('api', errorMessageFrom(data) || 'Durango did not record the task.');
      return { taskId: str(data.taskId), title: str(data.title) };
    },
    /** That thread ended: `{ machineId, outcome: 'finished' | 'failed', summary?, error? }` → `{ ok }`. */
    async reportBotTask({ taskId, ...body } = {}) {
      const data = await request('POST', `/code/bots/tasks/${encodeURIComponent(str(taskId))}/report`, { body });
      return { ok: data.ok === true };
    },
    /**
     * That thread still runs but needs the person or looks stuck:
     * `{ machineId, notice: { kind, key, seq, detail } }` → `{ ok, stale? }`.
     * Never on /report: a Durango from before notices would take it for a
     * report without an outcome and fail the task ("the thread stopped").
     */
    async noticeBotTask({ taskId, ...body } = {}) {
      const data = await request('POST', `/code/bots/tasks/${encodeURIComponent(str(taskId))}/notice`, { body });
      return { ok: data.ok === true, ...(data.stale === true ? { stale: true } : {}) };
    },
    /** Outcome of a person- or Ship-button-started turn in a bot-started thread → `{ ok }`. */
    async reportBotThreadTurn(body = {}) {
      const data = await request('POST', '/code/bots/threads/report', { body });
      return { ok: data.ok === true };
    },
    /** A thread call's result (claim `threadCalls`): `{ machineId, callId, result }` → `{ ok }`. */
    async completeBotThreadCall({ signal, ...body } = {}) {
      const data = await request('POST', '/code/bots/threads/calls', { body, signal });
      return { ok: data.ok === true };
    },
    /** Notice while a person- or Ship-button-started turn in a bot-started thread needs the person or looks stuck. */
    async noticeBotThreadTurn(body = {}) {
      const data = await request('POST', '/code/bots/threads/notice', { body });
      return { ok: data.ok === true, ...(data.stale === true ? { stale: true } : {}) };
    },
    // --- Bots (Sidebar v3): the person's Durango bots and their threads ---------
    /** Whether the connected Durango server supports non-blocking pending bot attachments (null before listBots). */
    supportsPendingBotAttachments() {
      return pendingBotAttachmentsSupported;
    },
    /** → `{ allowed, bots, projectOrder, modelChoices, modelCatalog, pendingAttachments }` (the primary first; modelChoices: null from an older Durango). */
    async listBots() {
      const data = await request('GET', '/bots');
      pendingBotAttachmentsSupported = data.pendingAttachments === true;
      return {
        allowed: data.allowed === true,
        bots: Array.isArray(data.bots) ? data.bots : [],
        projectOrder: Array.isArray(data.projectOrder) ? data.projectOrder.filter((key) => typeof key === 'string') : [],
        modelChoices: normalizeBotModelChoices(data.modelChoices),
        modelCatalog: normalizeBotModelChoices(data.modelCatalog, 600),
        pendingAttachments: pendingBotAttachmentsSupported,
      };
    },
    /**
     * What this machine's bot-started threads wait on the person for, as a
     * whole set (Durango drops the ones not listed), so their bots' chats show
     * the cards: `{ machineId, machineName?, threads, failed? }` → `{ answers }`:
     * the person's answers given in a bot's chat, for this machine to apply.
     */
    async syncBotThreadRequests({ signal, ...body } = {}) {
      const data = await request('POST', '/code/bots/thread-requests', { body, signal });
      return { ok: data.ok === true, answers: Array.isArray(data.answers) ? data.answers : [] };
    },
    /** The person answers a bot-started thread's request from the bot's chat: `{ requestId, op, reply?, sealed? }` → `{ ok, machineName, online }`. */
    async answerBotThreadRequest(body = {}) {
      const data = await request('POST', '/bots/thread-requests/answer', { body });
      return {
        ok: data.ok === true,
        machineName: typeof data.machineName === 'string' ? data.machineName : null,
        online: data.online === true,
        ...(Number.isFinite(data.at) ? { at: data.at } : {}),
      };
    },
    /** Saves the person's manual Bots sidebar ordering (project groups and/or bots within one project) → `{ ok, projectOrder }`. */
    async reorderBots({ projectOrder, projectKey, botIds } = {}) {
      const body = {
        ...(Array.isArray(projectOrder) ? { projectOrder: projectOrder.map(str).filter(Boolean) } : {}),
        ...(typeof projectKey === 'string' && projectKey.trim() && Array.isArray(botIds)
          ? { projectKey: projectKey.trim(), botIds: botIds.map(str).filter(Boolean) }
          : {}),
      };
      const data = await request('PUT', '/bots/order', { body });
      return {
        ok: true,
        ...(Array.isArray(data?.projectOrder) ? { projectOrder: data.projectOrder.filter((key) => typeof key === 'string') } : {}),
      };
    },
    /** Sets a bot's reply model and/or reasoning effort → `{ model?, reasoningEffort?, bot? }`. */
    async setBotModel(botId, model, reasoningEffort) {
      const body = {
        ...(model ? { model: str(model) } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      };
      const data = await request('PATCH', `/bots/${encodeURIComponent(str(botId))}`, { body });
      return {
        model: typeof data.model === 'string' ? data.model : str(model),
        ...(data.reasoningEffort === null || typeof data.reasoningEffort === 'string'
          ? { reasoningEffort: data.reasoningEffort }
          : reasoningEffort !== undefined
            ? { reasoningEffort }
            : {}),
        ...(data.bot && typeof data.bot === 'object' ? { bot: data.bot } : {}),
      };
    },
    /** Renames a bot → `{ name, bot? }`. */
    async renameBot(botId, name) {
      const data = await request('PATCH', `/bots/${encodeURIComponent(str(botId))}`, { body: { name: str(name) } });
      return {
        name: typeof data.name === 'string' ? data.name : str(name),
        ...(data.bot && typeof data.bot === 'object' ? { bot: data.bot } : {}),
      };
    },
    /** Updates a bot's name, job and/or emoji (`emoji: null` clears it back to auto) → `{ name?, bot? }`. */
    async updateBot(botId, { name, job, emoji } = {}) {
      const body = {
        ...(name !== undefined ? { name: str(name) } : {}),
        ...(job !== undefined ? { job: str(job) } : {}),
        ...(emoji !== undefined ? { emoji: emoji === null ? null : str(emoji) } : {}),
      };
      const data = await request('PATCH', `/bots/${encodeURIComponent(str(botId))}`, { body });
      return {
        ...(typeof data.name === 'string' ? { name: data.name } : name !== undefined ? { name: str(name) } : {}),
        ...(data.bot && typeof data.bot === 'object' ? { bot: data.bot } : {}),
      };
    },
    /** Makes a project bot its project's primary → `{ ok: true, bot? }`. */
    async setBotProjectPrimary(botId) {
      const data = await request('PATCH', `/bots/${encodeURIComponent(str(botId))}`, { body: { projectPrimary: true } });
      return {
        ok: true,
        ...(data.bot && typeof data.bot === 'object' ? { bot: data.bot } : {}),
      };
    },
    /** Deletes (archives) a non-primary bot → `{ ok: true }`. */
    async deleteBot(botId) {
      await request('DELETE', `/bots/${encodeURIComponent(str(botId))}`);
      return { ok: true };
    },
    /** Clears all past conversation for a bot → `{ ok: true, bot? }`. */
    async clearBot(botId) {
      const data = await request('DELETE', `/bots/${encodeURIComponent(str(botId))}/messages`);
      return {
        ok: true,
        ...(data.bot && typeof data.bot === 'object' ? { bot: data.bot } : {}),
      };
    },
    /**
     * → `{ bot, messages, live, hasMore, hasNewer? }`: the newest page, the page
     * before `beforeSeq`, or the new messages after `afterSeq`. `read` marks the bot read.
     */
    async botThread(botId, { limit, read, beforeSeq, afterSeq } = {}) {
      return await request('GET', `/bots/${encodeURIComponent(str(botId))}/messages`, {
        query: {
          limit: clampInt(limit, 1, 200, 80),
          ...(Number.isSafeInteger(beforeSeq) ? { beforeSeq: String(beforeSeq) } : {}),
          ...(Number.isSafeInteger(afterSeq) ? { afterSeq: String(afterSeq) } : {}),
          ...(read ? { read: '1' } : {}),
          // Replies' cards (files, HTML pages, buttons): this version shows them.
          cards: '1',
        },
      });
    },
    /** `{ messageId, content, timeZone? }` → `{ seq }`. Never blocked by a reply in progress. */
    async sendBotMessage(botId, body, { account } = {}) {
      return await request('POST', `/bots/${encodeURIComponent(str(botId))}/messages`, { body, ...(account ? { account } : {}) });
    },
    /** Dismisses an ask_user question card without answering or starting a bot turn → `{ ok, dismissed, needsYou }`. */
    async dismissBotAsk(botId, body = {}, { account } = {}) {
      const data = await request('POST', `/bots/${encodeURIComponent(str(botId))}/ask/dismiss`, {
        body,
        ...(account ? { account } : {}),
      });
      return {
        ok: data?.ok !== false,
        dismissed: data?.dismissed !== false,
        needsYou: data?.needsYou === true,
      };
    },
    /**
     * A file for a bot message, saved to the person's library → `{ part, attachment, attached? }`.
     * When `botId`, `messageId` and `pendingId` are provided, Durango also resolves that pending
     * attachment on the already-sent message in one round trip.
     */
    async uploadBotAttachment({ name, bytes, contentType, account, botId, messageId, pendingId }) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), str(name) || 'file');
      if (botId) form.append('botId', str(botId));
      if (messageId) form.append('messageId', str(messageId));
      if (pendingId) form.append('pendingId', str(pendingId));
      return await request('POST', '/bots/attachments', { form, timeout: Math.max(timeoutMs, 180_000), ...(account ? { account } : {}) });
    },
    /** Updates a background-uploaded attachment on an already-sent bot message (status: included | failed | uploading). */
    async updateBotMessageAttachment({ botId, messageId, pendingId, status, part, error, account }) {
      return await request(
        'PATCH',
        `/bots/${encodeURIComponent(str(botId))}/messages/${encodeURIComponent(str(messageId))}/attachments`,
        {
          body: {
            pendingId: str(pendingId),
            status: str(status),
            ...(part ? { part } : {}),
            ...(error ? { error: str(error) } : {}),
          },
          ...(account ? { account } : {}),
        }
      );
    },
    /** Read links (an hour) for files in the person's bot threads, by library id → `[{ id, name, contentType, byteSize, url }]`. */
    async botFileLinks(ids) {
      const data = await request('GET', '/bots/files', { query: { ids: (Array.isArray(ids) ? ids : []).map(str).filter(Boolean).join(',') } });
      return (Array.isArray(data.files) ? data.files : [])
        .filter((file) => str(file?.id) && /^https?:\/\//.test(str(file?.url)))
        .map((file) => ({ id: str(file.id), name: str(file.name), contentType: str(file.contentType), byteSize: Number(file.byteSize) || 0, url: str(file.url) }));
    },
    /**
     * Titles for the changes and threads bot replies name: `{ changes: [chg_…], threads: [id] }` →
     * `{ changes: { [id]: { title, status, url } }, threads: { [id]: { title } } }` (only what the account can read).
     */
    async botRefs({ changes = [], threads = [] } = {}) {
      const query = {};
      if (changes.length) query.changes = changes.join(',');
      if (threads.length) query.threads = threads.join(',');
      const data = await request('GET', '/bots/refs', { query });
      const out = { changes: {}, threads: {} };
      for (const [id, ref] of Object.entries(data?.changes && typeof data.changes === 'object' ? data.changes : {})) {
        const url = str(ref?.url);
        if (str(ref?.title) && /^https?:\/\//.test(url)) out.changes[id] = { title: str(ref.title), status: str(ref.status), url };
      }
      for (const [id, ref] of Object.entries(data?.threads && typeof data.threads === 'object' ? data.threads : {})) {
        if (str(ref?.title)) out.threads[id] = { title: str(ref.title) };
      }
      return out;
    },
    /** Creates a new standalone (projectless) bot: `{ name, job?, emoji?, model?, timeZone? }` → the bot. */
    async createBot(body) {
      const data = await request('POST', '/bots', { body });
      if (!data.bot || typeof data.bot !== 'object') throw new DurangoError('api', errorMessageFrom(data) || 'Durango did not return the new bot.');
      return data.bot;
    },
    /** A project's bot, created the first time: `{ name, repoId?, machineId?, projectId?, timeZone? }` → the bot. */
    async ensureProjectBot(body) {
      const data = await request('POST', '/bots/projects', { body });
      if (!data.bot || typeof data.bot !== 'object') throw new DurangoError('api', errorMessageFrom(data) || 'Durango did not return the project bot.');
      return data.bot;
    },
    /** Creates a new bot in a project: `{ name, repoId?, machineId?, projectId?, projectKey?, botName?, job?, emoji?, model?, timeZone? }` → the bot. */
    async createProjectBot(body) {
      const data = await request('POST', '/bots/projects', { body: { ...body, createNew: true } });
      if (!data.bot || typeof data.bot !== 'object') throw new DurangoError('api', errorMessageFrom(data) || 'Durango did not return the new project bot.');
      return data.bot;
    },
    /** A project bot's notes and files → the project, or null for a bot without one. */
    async botProject(botId) {
      const data = await request('GET', `/bots/${encodeURIComponent(str(botId))}/project`);
      return data.project ?? null;
    },
    /**
     * A project file: Durango's server stores the bytes (no client storage
     * ids). `{ botId | key, name, bytes, contentType }` → `{ ok, fileId, name, replaced }`.
     */
    async uploadProjectFile({ botId, key, name, bytes, contentType, account }) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), str(name));
      if (botId) form.append('botId', str(botId));
      if (key) form.append('key', str(key));
      return await request('POST', '/bots/project-files', { form, timeout: Math.max(timeoutMs, 120_000), ...(account ? { account } : {}) });
    },
    /** A project's notes and files by its key (a project needs no bot) → the project. */
    async projectMemory(key) {
      const data = await request('GET', '/bots/projects/memory', { query: { key: str(key) } });
      return data.project ?? null;
    },
    /** Changes a project's notes and files by its key (actions as botProjectAction). */
    async projectMemoryAction(key, body, { account } = {}) {
      return await request('POST', '/bots/projects/memory', { body: { ...body, key: str(key) }, timeout: Math.max(timeoutMs, 60_000), ...(account ? { account } : {}) });
    },
    /** Changes a project bot's notes and files: `{ action: 'add_note' | 'delete_note' | 'delete_file', … }` (files upload with uploadProjectFile). */
    async botProjectAction(botId, body, { account } = {}) {
      return await request('POST', `/bots/${encodeURIComponent(str(botId))}/project`, { body, timeout: Math.max(timeoutMs, 60_000), ...(account ? { account } : {}) });
    },
    /** Bots made on this device while signed out (local-bots.js exportForSync) → `{ ok, bots: [{ localId, botId }] }`. */
    async importBots(payload, { account } = {}) {
      const data = await request('POST', '/bots/import', { body: payload, timeout: Math.max(timeoutMs, 60_000), ...(account ? { account } : {}) });
      if (data.ok !== true) throw new DurangoError('api', errorMessageFrom(data) || 'Durango did not accept the bots.');
      return {
        ok: true,
        // false: part of it was deferred (retry later; the import is idempotent).
        complete: data.complete !== false,
        bots: (Array.isArray(data.bots) ? data.bots : [])
          .filter((bot) => bot && typeof bot === 'object')
          .map((bot) => ({ localId: str(bot.localId), botId: str(bot.botId) })),
      };
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
    // --- Durango inference media (theme backdrops, theme-tools.js) ----------
    /**
     * One generated image's bytes: POST /images/generations with b64_json, so
     * no second download. Spends the user's Durango credits.
     */
    async generateImage({ model, prompt, aspectRatio, imageSize, signal }) {
      const data = await request('POST', '/images/generations', {
        body: {
          model,
          prompt,
          n: 1,
          response_format: 'b64_json',
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(imageSize ? { image_size: imageSize } : {}),
        },
        timeout: MEDIA_REQUEST_TIMEOUT_MS,
        signal,
      });
      const entry = Array.isArray(data.data) ? data.data[0] : null;
      const b64 = typeof entry?.b64_json === 'string' ? entry.b64_json : '';
      if (!b64) throw new DurangoError('api', 'Durango returned no image.');
      return {
        data: Buffer.from(b64, 'base64'),
        mimeType: str(entry.content_type) || 'image/png',
        creditsUsed: Number(data.usage?.credits_used ?? data.credits_used ?? 0) || null,
      };
    },
    /** Starts a video generation; resolves `{ runId }` to poll with videoGeneration. */
    async startVideoGeneration({ model, prompt, aspectRatio, duration, resolution, signal }) {
      const data = await request('POST', '/videos/generations', {
        body: {
          model,
          prompt,
          generate_audio: false,
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(duration ? { duration } : {}),
          ...(resolution ? { resolution } : {}),
        },
        timeout: 60_000,
        signal,
      });
      const runId = str(data.id ?? data.run_id);
      if (!runId) throw new DurangoError('api', 'Durango did not start the video generation.');
      return { runId };
    },
    /** `{ status: running|completed|failed, videoUrls, error, creditsUsed }`. */
    async videoGeneration(runId, { signal } = {}) {
      const data = await request('GET', `/videos/generations/${encodeURIComponent(str(runId))}`, { signal });
      const urls = Array.isArray(data.data) ? data.data.map((video) => str(video?.url)).filter(Boolean) : [];
      return {
        status: str(data.status) || 'running',
        videoUrls: urls,
        error: typeof data.error === 'string' ? data.error : str(data.error?.message) || null,
        creditsUsed: Number(data.usage?.credits_used ?? data.credits_used ?? 0) || null,
      };
    },
    /** Bytes of a generated image or video on Durango (an /api/v1 URL from above). */
    async downloadGeneratedMedia(mediaUrl, { signal } = {}) {
      const session = await readSession();
      if (!session?.token) throw notSignedIn();
      const credential = await credentials.get();
      const url = new URL(mediaUrl, credential.baseUrl);
      if (url.origin !== new URL(credential.baseUrl).origin || !url.pathname.startsWith('/api/v1/')) {
        throw new DurangoError('api', 'Refusing to download media from outside Durango.');
      }
      let response;
      try {
        const timeoutSignal = AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS);
        response = await fetchImpl(url, {
          headers: { authorization: `Bearer ${credential.key}` },
          signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
        });
      } catch (error) {
        throw networkError('Durango', error);
      }
      if (!response.ok) {
        throw new DurangoError('api', `Media download failed (${response.status}).`, { status: response.status });
      }
      return {
        data: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get('content-type') || 'application/octet-stream',
      };
    },
    // --- Community themes (durango.sh/code/themes, theme-community.js) --------
    // Writes take `{ anonymousKey }` to act as the device's anonymous owner
    // instead of the signed-in account (sharing needs no account).
    /** Whether a Durango account is signed in on this device. */
    async signedIn() {
      return Boolean((await readSession().catch(() => null))?.token);
    },
    /** `assets: [{ name, sha256, size }]` → `[{ name, sha256, contentType, uploadUrl | null }]`. */
    async prepareThemeUploads(assets, { signal, anonymousKey } = {}) {
      const data = await themeRequest('POST', '/themes/uploads', { body: { assets }, signal, anonymousKey });
      return Array.isArray(data.uploads) ? data.uploads : [];
    },
    /** Shares a theme (or updates the shared one: `slug`); resolves its summary. */
    async publishTheme(body, { signal, anonymousKey } = {}) {
      return themeRequest('POST', '/themes', { body, timeout: 60_000, signal, anonymousKey });
    },
    async setSharedThemeListed(slug, listed, { anonymousKey } = {}) {
      return themeRequest('PATCH', `/themes/${encodeURIComponent(str(slug))}`, { body: { listed: listed === true }, anonymousKey });
    },
    async deleteSharedTheme(slug, { anonymousKey } = {}) {
      return themeRequest('DELETE', `/themes/${encodeURIComponent(str(slug))}`, { anonymousKey });
    },
    async listOwnSharedThemes({ anonymousKey } = {}) {
      const data = await themeRequest('GET', '/themes/mine', { anonymousKey });
      return Array.isArray(data.themes) ? data.themes : [];
    },
    /** Counts an install for the signed-in account (once per account). */
    async recordThemeInstall(slug) {
      return request('POST', `/themes/${encodeURIComponent(str(slug))}/installs`);
    },
    /** A shared theme with its files' download URLs; public, no account needed. */
    async communityTheme(slug, { signal } = {}) {
      return publicGet(`/themes/${encodeURIComponent(str(slug))}`, { signal });
    },
    /** The public gallery: `{ themes, nextOffset }`. */
    async communityThemes({ q, sort, limit } = {}, { signal } = {}) {
      return publicGet('/themes', { query: { q, sort, limit }, signal });
    },
  };
};

const MEDIA_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

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

// DURANGO_MOCK_BOT_LANES=<file.json> (with DURANGO_MOCK=1): bot replies to
// offer, one after the other, for checking machine replies end to end on real
// harnesses without an account: `{ log: <file.jsonl>, bots?: [...], lanes:
// [{ ...lane, inbox?: [[item…]…], beforeFinish?: [[item…]…], toolResults?: { name: result } }] }`.
// Everything the app sends back (claims with its presence, progress, tool
// calls, messages, finishes) is appended to `log`.
const readMockBotLanes = (file) => {
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[durango mock] bot lanes file unreadable:', error?.message ?? error);
    return null;
  }
};

export const createMockDurangoClient = ({ dispatchDelayMs = 4_000, botLanesFile = process.env.DURANGO_MOCK_BOT_LANES } = {}) => {
  const remembered = [];
  const mockBots = readMockBotLanes(botLanesFile);
  const mockLanes = Array.isArray(mockBots?.lanes) ? [...mockBots.lanes] : [];
  const mockRunning = new Map(); // laneId -> its fixture (inbox to hand out)
  const mockLog = (entry) => {
    if (!mockBots?.log) return;
    try {
      appendFileSync(mockBots.log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    } catch {}
  };
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
    async noticeDispatch() {
      return { ok: false };
    },
    async reportDispatch(dispatchId, report) {
      reports.push({ dispatchId, ...report });
      console.log(`[durango mock] dispatch ${dispatchId} → ${report?.status}${report?.error ? ` (${report.error})` : ''}`);
      return { ok: true };
    },
    // Without DURANGO_MOCK_BOT_LANES the claim just waits, like an idle Durango.
    // With it, the next fixture lane is offered once the previous one finished.
    async claimBotLane({ waitMs = DISPATCH_CLAIM_WAIT_MS, signal, ...body } = {}) {
      mockLog({ kind: 'claim', machine: body.machine ?? null, features: body.features ?? [] });
      if (mockLanes.length && mockRunning.size === 0) {
        const fixture = mockLanes.shift();
        const lane = normalizeBotLane(fixture);
        if (lane) {
          mockRunning.set(lane.laneId, { inbox: [...(fixture.inbox ?? [])], beforeFinish: [...(fixture.beforeFinish ?? [])], toolResults: fixture.toolResults ?? {} });
          mockLog({ kind: 'offered', laneId: lane.laneId, modelId: lane.modelId });
          return { lane };
        }
      }
      await waitFor(Math.min(clampInt(waitMs, 0, DISPATCH_CLAIM_WAIT_MS, DISPATCH_CLAIM_WAIT_MS), mockRunning.size ? 2_000 : 25_000), signal);
      return { lane: null };
    },
    async reportBotLaneProgress({ laneId, text, activeTool, takeInbox, beforeFinish } = {}) {
      const fixture = mockRunning.get(laneId);
      const inbox = fixture && takeInbox ? ((beforeFinish ? fixture.beforeFinish : fixture.inbox).shift() ?? []) : [];
      mockLog({ kind: 'progress', laneId, text, activeTool: activeTool ?? null, takeInbox: Boolean(takeInbox), beforeFinish: Boolean(beforeFinish), inbox });
      return { stop: false, inbox: normalizeBotInbox(inbox) };
    },
    async callBotLaneTool({ laneId, name, input, message } = {}) {
      const result = mockRunning.get(laneId)?.toolResults?.[str(name)];
      mockLog({ kind: 'tool', laneId, name, input, message: message ?? null, answered: result !== undefined });
      return { result: result ?? { ok: false, error: `Mock Durango has no bot tool ${str(name)}.` } };
    },
    async sendBotLaneMessage({ laneId, ...body } = {}) {
      reports.push({ laneId, message: true, ...body });
      mockLog({ kind: 'message', laneId, ...body });
      return { ok: true, stop: false };
    },
    async finishBotLane({ laneId, ...body } = {}) {
      reports.push({ laneId, ...body });
      mockRunning.delete(laneId);
      mockLog({ kind: 'finish', laneId, ...body });
      return { ok: true, stored: true };
    },
    async createBotLaneTask() {
      throw new DurangoError('api', 'Mock Durango has no bot tasks.');
    },
    async reportBotTask() {
      return { ok: false };
    },
    async noticeBotTask() {
      return { ok: false };
    },
    async reportBotThreadTurn() {
      return { ok: false };
    },
    async completeBotThreadCall(body = {}) {
      mockLog({ kind: 'threadCall', ...body });
      return { ok: true };
    },
    async noticeBotThreadTurn() {
      return { ok: false };
    },
    async chatUrl(chatId) {
      return MOCK_CHATS.find((chat) => chat.id === chatId)?.url ?? `${DEFAULT_DURANGO_URL}/chats`;
    },
    async listBots() {
      return {
        allowed: true,
        bots: Array.isArray(mockBots?.bots) ? mockBots.bots : [],
        projectOrder: [],
        modelChoices: mockBots?.modelChoices ?? null,
        modelCatalog: mockBots?.modelCatalog ?? null,
      };
    },
    async syncBotThreadRequests() {
      return { ok: true, answers: [] };
    },
    async answerBotThreadRequest() {
      return { ok: true, machineName: null, online: true };
    },
    async reorderBots({ projectOrder } = {}) {
      return { ok: true, ...(Array.isArray(projectOrder) ? { projectOrder } : {}) };
    },
    async setBotModel(_botId, model, reasoningEffort) {
      return {
        ...(model ? { model: str(model) } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      };
    },
    async renameBot(_botId, name) {
      return { name: str(name) };
    },
    async updateBot(_botId, { name } = {}) {
      return { ...(name !== undefined ? { name: str(name) } : {}) };
    },
    async setBotProjectPrimary() {
      return { ok: true };
    },
    async deleteBot() {
      return { ok: true };
    },
    async clearBot() {
      return { ok: true };
    },
    async botFileLinks() {
      return [];
    },
    async botRefs() {
      return { changes: {}, threads: {} };
    },
    async botThread(botId) {
      const bot = (Array.isArray(mockBots?.bots) ? mockBots.bots : []).find((item) => item?.id === botId) ?? null;
      return { bot, messages: [], live: [], hasMore: false };
    },
    async createBot() {
      throw new DurangoError('api', 'Mock Durango cannot create bots.');
    },
    async ensureProjectBot() {
      throw new DurangoError('api', 'Mock Durango has no project bots.');
    },
    async createProjectBot() {
      throw new DurangoError('api', 'Mock Durango has no project bots.');
    },
    async botProject() {
      return null;
    },
    async botProjectAction() {
      throw new DurangoError('api', 'Mock Durango has no project bots.');
    },
    async projectMemory() {
      return null;
    },
    async uploadProjectFile() {
      throw new DurangoError('api', 'Mock Durango has no project files.');
    },
    async projectMemoryAction() {
      throw new DurangoError('api', 'Mock Durango has no project bots.');
    },
    supportsPendingBotAttachments() {
      return false;
    },
    async sendBotMessage() {
      return { seq: 0 };
    },
    async dismissBotAsk() {
      return { ok: true, dismissed: true, needsYou: false };
    },
    async updateBotMessageAttachment() {
      return { ok: true };
    },
    async importBots(payload) {
      const bots = Array.isArray(payload?.bots) ? payload.bots : [];
      return { ok: true, bots: bots.map((bot, index) => ({ localId: str(bot?.localId), botId: `mockbot${index}` })) };
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
