// Durango Source change-description images for the renderer. Agent replies
// embed them as /api/source/repos/<owner>/<repo>/attachments/<id> (the
// Markdown `durango-code change attach` prints); the renderer rewrites those
// to orion-source-attachment://source/<owner>/<repo>/<id>?account=<user id>
// (src/app/sourceAttachments.ts) and this handler fetches the bytes from the
// Durango web origin with the device's repository token, which durango.sh
// accepts for attachment reads. The token never reaches the renderer, and
// only ever goes to the configured web origin.
//
// Account isolation: the URL names the signed-in account and is refused for
// any other, so after an account change the renderer asks for new URLs and
// nothing Chromium kept for the old ones is shown. Responses are no-store.
// Fetched bytes are kept in a small in-memory cache keyed by account; an
// account change (clear()) empties it and drops loads still in flight.

export const SOURCE_ATTACHMENT_PROTOCOL = 'orion-source-attachment';

const ATTACHMENT_ID = /^att_[A-Za-z0-9]+$/;
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

const decodeSegment = (value) => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !/[/\\]/.test(decoded) && decoded !== '.' && decoded !== '..' ? decoded : null;
  } catch {
    return null;
  }
};

/** owner, repo, attachment id and account of an orion-source-attachment URL, or null. */
export const parseSourceAttachmentUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== `${SOURCE_ATTACHMENT_PROTOCOL}:` || url.hostname !== 'source') return null;
  const parts = url.pathname.split('/').slice(1);
  if (parts.length !== 3) return null;
  const owner = decodeSegment(parts[0]);
  const name = decodeSegment(parts[1]);
  const attachmentId = parts[2];
  const account = url.searchParams.get('account');
  if (!owner || !name || !ATTACHMENT_ID.test(attachmentId) || !account) return null;
  return { owner, name, attachmentId, account };
};

const textResponse = (status, message) =>
  new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export const createSourceAttachmentHandler = ({ credentials, webOrigin, fetchImpl = fetch }) => {
  const cache = new Map();
  let cachedBytes = 0;
  const inflight = new Map();
  // Bumped by clear() (sign-in, sign-out): loads begun before it never reach
  // the cache or the renderer.
  let generation = 0;

  const remember = (key, entry) => {
    if (entry.bytes.byteLength > CACHE_MAX_BYTES) return;
    cache.set(key, entry);
    cachedBytes += entry.bytes.byteLength;
    for (const [oldKey, oldEntry] of cache) {
      if (cache.size <= CACHE_MAX_ENTRIES && cachedBytes <= CACHE_MAX_BYTES) break;
      cache.delete(oldKey);
      cachedBytes -= oldEntry.bytes.byteLength;
    }
  };

  const load = async ({ owner, name, attachmentId }, token, signal) => {
    const url = new URL(
      `/api/source/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/attachments/${attachmentId}`,
      new URL(webOrigin()).origin
    );
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'image/*' },
        signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), signal]),
        redirect: 'error',
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !contentType.startsWith('image/')) {
        return { status: response.ok ? 502 : response.status, message: 'Durango did not return this image.' };
      }
      return { status: 200, contentType, bytes: new Uint8Array(await response.arrayBuffer()) };
    } catch (error) {
      if (signal.aborted) return { status: 401, message: 'The Durango account changed.' };
      return { status: 502, message: `Could not reach Durango (${error?.message ?? error}).` };
    }
  };

  const handle = async (request) => {
    const target = parseSourceAttachmentUrl(request.url);
    if (!target) return textResponse(404, 'Not found');
    const startedIn = generation;
    let credential;
    try {
      credential = await credentials.get();
    } catch (error) {
      return textResponse(error?.needsAuth ? 401 : 503, error?.message || 'Sign in to Durango to see this image.');
    }
    // Only the signed-in account's own URLs load (see the header comment).
    if (startedIn !== generation || !credential?.user?.id || credential.user.id !== target.account) {
      return textResponse(401, 'This image belongs to another Durango account.');
    }
    const key = [new URL(webOrigin()).origin, target.account, target.owner, target.name, target.attachmentId].join('\n');
    let entry = cache.get(key);
    if (entry) {
      // Most recently used last, so eviction drops the oldest.
      cache.delete(key);
      cache.set(key, entry);
    } else {
      let pending = inflight.get(key);
      if (!pending) {
        const controller = new AbortController();
        const loadGeneration = generation;
        const loading = load(target, credential.token, controller.signal);
        pending = { generation: loadGeneration, controller, promise: loading };
        inflight.set(key, pending);
        void loading.finally(() => {
          if (inflight.get(key) === pending) inflight.delete(key);
        });
      }
      entry = await pending.promise;
      if (pending.generation !== generation) return textResponse(401, 'The Durango account changed.');
      if (entry.status !== 200) return textResponse(entry.status, entry.message);
      if (!cache.has(key)) remember(key, entry);
    }
    return new Response(entry.bytes, {
      headers: {
        'content-type': entry.contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  };

  // Sign-in and sign-out: the next account may not be allowed to read these.
  const clear = () => {
    generation += 1;
    for (const pending of inflight.values()) pending.controller.abort();
    inflight.clear();
    cache.clear();
    cachedBytes = 0;
  };

  return { handle, clear };
};
