import { isSameWebOrigin } from './web-origin.js';

// Repository credentials are separate from account sessions: expiring the UI
// session must not break Git. Explicit sign-out clears them; sign-in replaces
// them. Only the main process ever receives the plaintext credential.
export const createRepositoryCredentials = ({ readSession, readStored, writeStored, removeStored, origin, deviceName, fetchImpl = fetch }) => {
  const authError = (message) => Object.assign(new Error(message), { needsAuth: true, status: 401 });
  let generation = 0;
  let pending = null;
  let cached = null;
  let suspended = false;
  let storageQueue = Promise.resolve();
  const serialize = operation => {
    const next = storageQueue.then(operation, operation);
    storageQueue = next.catch(() => {});
    return next;
  };
  const revoke = async credential => {
    if (!credential?.token) return;
    try {
      await fetchImpl(new URL('/api/desktop-auth/repository-token', credential.origin), {
        method: 'DELETE', headers: { authorization: `Bearer ${credential.token}` },
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
    } catch { /* Local sign-out must still work offline. Settings can revoke remotely. */ }
  };
  const clear = ({ revokeRemote = false } = {}) => {
    // Block new requests as well as requests that began before sign-out.
    // The account session file may still exist while its removal is pending.
    suspended = true;
    generation += 1;
    pending = null;
    const previous = cached;
    cached = null;
    return serialize(async () => {
      const stored = previous ?? await readStored();
      await removeStored();
      if (revokeRemote) void revoke(stored);
    });
  };
  const get = () => {
    if (suspended) return Promise.reject(authError('Sign in to Durango to authorize repository access on this device.'));
    if (pending) return pending;
    const version = generation;
    const base = new URL(origin()).origin;
    const operation = (async () => {
      const session = await readSession();
      const stored = cached ?? await serialize(readStored);
      if (version !== generation) throw new Error('Durango account changed. Try again.');
      // A credential minted on a retired origin (code.durango.sh) stays valid
      // on durango.sh (same tokens), so it is reused rather than re-minted.
      if (isSameWebOrigin(stored?.origin, base) && stored.token && (!session?.user || stored.user?.id === session.user.id)) {
        cached = stored;
        return { token: stored.token, user: stored.user, expiresAt: null };
      }
      if (!session?.token || (session.expiresAt && Date.parse(session.expiresAt) <= Date.now())) {
        throw authError('Sign in to Durango once to authorize repository access on this device.');
      }
      const response = await fetchImpl(new URL('/api/desktop-auth/repository-token', base), {
        method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: deviceName }), signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      const data = await response.json().catch(() => ({}));
      // Older Cloud deployments can still use the existing session until the
      // token endpoint is available. Never downgrade an invalid/revoked PAT.
      if (response.status === 404 && version === generation) return session;
      if (!response.ok) throw Object.assign(new Error(data.error || `Could not authorize Durango Cloud repository access (${response.status}).`), {
        status: response.status, needsAuth: response.status === 401, data,
      });
      if (!/^orion_pat_[0-9a-f]{64}$/.test(data.token ?? '')) throw new Error('Durango Code returned an invalid repository credential.');
      const credential = { origin: base, token: data.token, id: data.id, user: session.user };
      await serialize(async () => {
        if (version !== generation) { void revoke(credential); throw new Error('Durango account changed. Try again.'); }
        await writeStored(credential);
        if (version !== generation) { void revoke(credential); throw new Error('Durango account changed. Try again.'); }
        cached = credential;
      });
      return { token: credential.token, user: credential.user, expiresAt: null };
    })();
    pending = operation;
    void operation.finally(() => { if (pending === operation) pending = null; }).catch(() => {});
    return operation;
  };
  const resume = () => { suspended = false; };
  // Durango identity cutover: the same session's native Clerk id changed.
  // The stored credential is owned by the unchanged app user, so rebind it
  // instead of letting get() mint (and orphan) a second token.
  const rebindUser = (fromUserId, user) => {
    if (!fromUserId || !user?.id || fromUserId === user.id) return Promise.resolve(false);
    const version = generation;
    return serialize(async () => {
      if (version !== generation) return false;
      const stored = cached ?? await readStored();
      if (!stored?.token || stored.user?.id !== fromUserId) return false;
      const next = { ...stored, user };
      await writeStored(next);
      if (version !== generation) return false;
      cached = next;
      return true;
    });
  };
  return { get, clear, resume, rebindUser };
};
