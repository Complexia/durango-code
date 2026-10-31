// ---------------------------------------------------------------------------
// Connectors from the Durango account (durango.sh Settings → Connectors). When
// Durango Code is signed in to Durango, they're added to every run next to the
// MCP servers connected to Durango Code itself (orion-mcps.js), which keep
// working on their own without an account. Each is an HTTP MCP server on
// durango.sh that proxies to the connected app; the upstream credentials stay
// on durango.sh and this device authenticates with its own Durango key.
//
// Best effort by design: a slow or failed listing costs a turn these servers,
// never the turn itself. Names are `durango-<slug>`, and a local server with
// the same name wins.

const CACHE_MS = 60_000;
// How long a turn waits for a listing it has no cached copy of.
const RUN_WAIT_MS = 4_000;

export const createAccountConnectors = ({ getClient, isSignedIn, reservedNames = new Set(), now = Date.now }) => {
  let cached = null; // { at, value: { connectors, authorization } }
  let inflight = null;
  let generation = 0;

  // A listing started before clear() (sign-out, sign-in) belongs to the old
  // account: it is neither cached nor handed to anyone.
  const load = () => {
    if (inflight) return inflight;
    const startedGeneration = generation;
    const pending = (async () => {
      try {
        const value = await getClient().listConnectors({ timeout: 10_000 });
        if (startedGeneration !== generation) return null;
        cached = { at: now(), value };
        return value;
      } finally {
        if (inflight === pending) inflight = null;
      }
    })();
    inflight = pending;
    return pending;
  };

  const current = async ({ fresh = false, waitMs } = {}) => {
    if (!(await isSignedIn())) {
      cached = null;
      return null;
    }
    if (!fresh && cached && now() - cached.at < CACHE_MS) return cached.value;
    const pending = load();
    if (waitMs === undefined) return pending;
    // A turn takes the last good list over waiting on a slow refresh.
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(cached?.value ?? null), waitMs);
    });
    try {
      return await Promise.race([pending.catch(() => cached?.value ?? null), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    /** For Settings: the account's connectors (no credentials). */
    async list({ fresh = true } = {}) {
      try {
        const value = await current({ fresh });
        if (!value) return { ok: true, signedIn: false, connectors: [] };
        return {
          ok: true,
          signedIn: true,
          connectors: value.connectors.map(({ id, kind, name, serverName }) => ({ id, kind, name, serverName })),
        };
      } catch (error) {
        return { ok: false, signedIn: true, connectors: [], error: error?.message ?? String(error) };
      }
    },

    /**
     * HTTP MCP entries (the shape resolveOrionMcpsForRun returns) for a run.
     * `taken` are the names already in use (Durango Code's own servers).
     */
    async forRun({ taken = [] } = {}) {
      let value;
      try {
        value = await current({ waitMs: RUN_WAIT_MS });
      } catch (error) {
        console.warn('Durango connectors unavailable for this run:', error?.message ?? error);
        return [];
      }
      if (!value?.connectors?.length) return [];
      const used = new Set(taken);
      const servers = [];
      for (const connector of value.connectors) {
        if (used.has(connector.serverName) || reservedNames.has(connector.serverName)) continue;
        used.add(connector.serverName);
        servers.push({
          name: connector.serverName,
          transport: 'http',
          url: connector.url,
          headers: { Authorization: value.authorization },
        });
      }
      return servers;
    },

    /** Sign-out (or an account switch): forget the list and the key it carried. */
    clear() {
      generation += 1;
      cached = null;
      inflight = null;
    },
  };
};
