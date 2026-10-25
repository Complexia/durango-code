import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { app, safeStorage } from 'electron';
import {
  MAX_FRAME_BYTES,
  REMOTE_PROTOCOL_VERSION,
  SecureChannel,
  confirmationMac,
  createEphemeralKeyPair,
  deriveHandshakeKeys,
  generatePairingCode,
  handshakeTranscript,
  macsEqual,
  normalizePairingCode,
  pairingCodeToPsk,
} from './remote-crypto.js';
import {
  createRelayListener,
  createRelayTransport,
  createTcpTransport,
  wrapTcpSocket,
} from './remote-transport.js';

// Remote control engine: lets a signed-in Orion instance be driven by other
// paired instances on the same account (host side), and drive them (controller
// side). Protocol and threat model documented in remote-crypto.js. Everything
// here is inert until the renderer pushes enabled settings AND an account
// session exists — signing out tears the server and every connection down
// immediately.
//
// Two connection modes, chosen by `settings.connectionMode`:
//
// - 'direct' (default): machines reach each other over TCP on the LAN or a
//   VPN. Nothing contacts Orion Cloud's relay — not one request.
// - 'relay': the host also holds an outbound WebSocket to the relay and
//   controllers reach it by machine id. The relay is an untrusted byte pipe;
//   inbound relay streams go through the SAME handshake path, the same
//   connection caps, the same pre-auth frame budget, and the same confirm-stage
//   re-authorization as an accepted TCP socket. There is deliberately no
//   second, laxer inbound path.

export const DEFAULT_REMOTE_PORT = 47615;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RUN_TURN_TIMEOUT_MS = 120_000;
const CLIENT_RESPONSE_GRACE_MS = 10_000;
const WORKSPACE_EVENT_DEBOUNCE_MS = 1500;
// Failed-handshake rate limit per remote IP (brute-force backstop; the real
// guard is the 78+ bit code / 256-bit secret).
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
// Unauthenticated connections are cheap to open and expensive to buffer, so
// they are capped globally and per source address, and held to a frame budget
// that fits a handshake (a few hundred bytes) until encryption is up.
const MAX_INBOUND_CONNECTIONS = 32;
const MAX_INBOUND_PER_IP = 6;
const HANDSHAKE_FRAME_BYTES = 4096;
// Large saved threads travel as independently requested chunks. Base64 grows
// each chunk by a third; 4 MiB leaves ample room for the response envelope and
// authenticated-encryption overhead under MAX_FRAME_BYTES.
const THREAD_CHUNK_BYTES = 4 * 1024 * 1024;
// Remote transcript pulls are intentionally bounded even after authentication.
// A paired host controls threadBytes, and the controller accumulates chunks
// before parsing them, so accepting an arbitrary total would permit unbounded
// memory growth and request loops.
const MAX_THREAD_TRANSFER_BYTES = 64 * 1024 * 1024;
// Retain at most one serialized transcript per authenticated host session, and
// release it if a controller abandons the pull transfer.
const THREAD_TRANSFER_TTL_MS = 2 * 60 * 1000;
const ENCRYPTED_FRAME_OVERHEAD_BYTES = 8 + 16;
// Relay streams have no meaningful source address — the relay is the only peer
// the socket layer can see. They therefore share one bucket for the per-source
// connection cap and the failed-handshake rate limit. That is the conservative
// choice: it means a flood arriving over the relay is throttled like a flood
// from a single IP, at the cost of one abusive controller being able to slow
// relay handshakes for the others. Direct connections are unaffected.
const RELAY_SOURCE = 'relay';

const remoteStateFileName = 'orion-remote-control.json';
const getRemoteStateFilePath = () => path.join(app.getPath('userData'), remoteStateFileName);

let deps = null;
let settings = {
  enabled: false,
  allowIncoming: false,
  port: DEFAULT_REMOTE_PORT,
  connectionMode: 'direct',
};
let identity = null; // { machineId, machineName }
let hostDevices = []; // controllers allowed to control this machine
let remoteMachines = []; // machines this instance can control
let currentUserId = null; // refreshed from the account session on reconcile

let server = null;
let listening = false;
let listenError = null;
let listeningPort = null;
let pairing = null; // { code, psk, expiresAt, attempts, timer }
// Relay (internet) mode. All three stay untouched — and every relay code path
// stays unreached — while connectionMode is 'direct'.
let relayListener = null;
let relayOnline = false;
let relayError = null;
let relayRegisteredFor = null; // userId this machine is registered with
let reconcileQueue = Promise.resolve();
let accountExpiryTimer = null;
let accountGeneration = 0;
let workspaceEventTimer = null;
let stateLoaded = false;
// Terminal process-lifecycle guard. Once Electron begins quitting, no queued
// settings/account reconciliation may recreate sockets behind the quit
// barrier.
let shuttingDown = false;
// Set when pairings cannot be read or persisted at all; surfaced to the
// renderer instead of pretending the feature works.
let stateError = null;
// Serializes complete persisted-state operations, not just their writes. A
// mutation that later rolls back must finish before another mutation can take
// its snapshot, otherwise an earlier failed save can restore stale credentials
// over a later successful revoke.
let persistedStateQueue = Promise.resolve();

const hostSessions = new Set(); // inbound controller sessions (post-handshake)
// Every live inbound connection, including ones still handshaking. Revoking a
// device, signing out, or stopping the listener must reach these too — a
// connection parked between hello and confirm is not in hostSessions yet.
const inboundConnections = new Set();
const clientSessions = new Map(); // machineId -> outbound session
// Pairing connections are intentionally separate from reusable client
// sessions, but must still be lifecycle-owned so disabling Remote Control can
// abort a handshake or an in-flight account-proof request.
const outboundPairingAttempts = new Set();
const pendingRendererCommands = new Map(); // commandId -> { resolve, timer }
// Renderer work is authorized by both the current incoming-control lifetime
// and the exact credential lifetime of the controller that submitted it.
let hostAuthorizationGeneration = 0;
const hostDeviceAuthorizationGenerations = new Map(); // deviceId -> generation
const handshakeFailures = new Map(); // ip -> { count, resetAt }

// ---------------------------------------------------------------------------
// Persistence (device secrets encrypted like the account token: OS keychain in
// packaged builds, plaintext in dev to avoid keychain prompts under the stock
// Electron signature).

const selectedSafeStorageBackend = () => {
  if (!app.isPackaged || typeof safeStorage.getSelectedStorageBackend !== 'function') return null;
  try {
    return safeStorage.getSelectedStorageBackend();
  } catch {
    return null;
  }
};

const pairingPersistenceUnavailable = () => {
  if (!app.isPackaged) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    return 'This system has no secure storage available, so pairings cannot be saved. Remote control is unavailable.';
  }
  if (selectedSafeStorageBackend() === 'basic_text') {
    return 'This system is using unprotected basic-text credential storage, so pairings cannot be saved. Remote control is unavailable.';
  }
  return null;
};

const canUseSafeStorage = () => app.isPackaged && !pairingPersistenceUnavailable();

const requirePairingPersistence = () => {
  if (stateLoaded && !identity) {
    throw new Error(stateError ?? 'Remote control pairing state is unavailable.');
  }
  const error = pairingPersistenceUnavailable();
  if (!error) return;
  stateError = error;
  publishState();
  throw new Error(error);
};

const encryptSecret = (secretBase64) => {
  if (!canUseSafeStorage()) return { encrypted: false, value: secretBase64 };
  return { encrypted: true, value: safeStorage.encryptString(secretBase64).toString('base64') };
};

const decryptSecret = (stored) => {
  if (!stored || typeof stored !== 'object') return null;
  if (stored.encrypted) {
    if (!app.isPackaged) return null;
    try {
      return safeStorage.decryptString(Buffer.from(String(stored.value || ''), 'base64'));
    } catch {
      return null;
    }
  }
  return typeof stored.value === 'string' ? stored.value : null;
};

const loadPersistedState = async () => {
  identity = null;
  hostDevices = [];
  remoteMachines = [];
  hostDeviceAuthorizationGenerations.clear();
  let needsInitialSave = false;
  try {
    const raw = await fs.readFile(getRemoteStateFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    // A file that parses but carries no usable machine id is as damaged as one
    // that does not parse: minting a fresh id here would silently orphan this
    // machine from every controller that has it paired.
    if (typeof parsed?.machineId !== 'string' || !parsed.machineId) {
      throw new Error('Pairing file has no machine id.');
    }
    identity = {
      machineId: parsed.machineId,
      machineName:
        typeof parsed.machineName === 'string' && parsed.machineName
          ? parsed.machineName
          : os.hostname(),
    };
    for (const entry of Array.isArray(parsed?.hostDevices) ? parsed.hostDevices : []) {
      const secret = decryptSecret(entry?.secret);
      if (!secret) throw new Error('A controller credential could not be decrypted.');
      if (typeof entry?.id !== 'string' || !entry.id) {
        throw new Error('A persisted controller credential is malformed.');
      }
      hostDevices.push({
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : 'Unknown device',
        userId: typeof entry.userId === 'string' ? entry.userId : null,
        secret,
        pairedAt: typeof entry.pairedAt === 'string' ? entry.pairedAt : null,
        lastSeenAt: typeof entry.lastSeenAt === 'string' ? entry.lastSeenAt : null,
      });
    }
    for (const entry of Array.isArray(parsed?.remoteMachines) ? parsed.remoteMachines : []) {
      const secret = decryptSecret(entry?.secret);
      // A machine paired over the relay has no address of its own — the
      // machine id IS the route. Entries written before relay support always
      // carry host+port and load exactly as before.
      const host = typeof entry?.host === 'string' && entry.host ? entry.host : null;
      const port = Number.isInteger(entry?.port) ? entry.port : null;
      const relay = entry?.relay === true;
      if (!secret) throw new Error('A remote-machine credential could not be decrypted.');
      if (typeof entry?.id !== 'string' || !entry.id || (!relay && (!host || port === null))) {
        throw new Error('A persisted remote-machine credential is malformed.');
      }
      remoteMachines.push({
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : (host ?? entry.id),
        host,
        port,
        relay,
        userId: typeof entry.userId === 'string' ? entry.userId : null,
        secret,
        pairedAt: typeof entry.pairedAt === 'string' ? entry.pairedAt : null,
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A corrupt or unreadable file must not silently mint a new identity and
      // overwrite it: that would drop every pairing AND change the machine id
      // every paired controller knows us by. Refuse to run instead.
      console.error('remote-control: load error', error);
      identity = null;
      hostDevices = [];
      remoteMachines = [];
      hostDeviceAuthorizationGenerations.clear();
      stateError = 'Could not read the remote control pairing file. Remote control is unavailable.';
      stateLoaded = true;
      return;
    }
  }
  if (!identity) {
    identity = { machineId: crypto.randomUUID(), machineName: os.hostname() };
    needsInitialSave = true;
  }
  const persistenceError = pairingPersistenceUnavailable();
  if (persistenceError) {
    stateError = persistenceError;
    stateLoaded = true;
    return;
  }
  // A newly minted identity must be durable before the engine is exposed.
  // A write failure disables remote control without preventing Orion itself
  // from finishing startup.
  if (needsInitialSave) {
    try {
      await savePersistedState();
    } catch {
      identity = null;
      stateLoaded = true;
      return;
    }
  }
  stateLoaded = true;
};

const writePersistedState = async () => {
  // No identity means the pairing file could not be loaded; writing now would
  // overwrite it with a half-built state.
  if (!identity) throw new Error(stateError ?? 'Remote control pairing state is unavailable.');
  // Packaged builds never persist device secrets without OS-backed
  // encryption. Nothing would survive a restart, so say so rather than let
  // pairings appear to succeed and silently vanish.
  requirePairingPersistence();
  const filePath = getRemoteStateFilePath();
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const payload = {
    version: 1,
    machineId: identity.machineId,
    machineName: identity.machineName,
    hostDevices: hostDevices.map((device) => ({
      id: device.id,
      name: device.name,
      userId: device.userId,
      secret: encryptSecret(device.secret),
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
    })),
    remoteMachines: remoteMachines.map((machine) => ({
      id: machine.id,
      name: machine.name,
      host: machine.host,
      port: machine.port,
      relay: machine.relay === true,
      userId: machine.userId,
      secret: encryptSecret(machine.secret),
      pairedAt: machine.pairedAt,
    })),
  };
  // Written through a temp file: a torn write here would cost every pairing on
  // this machine. Mode 0600 — device secrets each grant full control of this
  // Orion instance. Callers serialize this together with the state mutation.
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const handle = await fs.open(tempPath, 'w', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf-8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
    // A transient EIO must not pin an error banner for the rest of the
    // process; a recovered write clears it.
    if (stateError) {
      stateError = null;
      publishState();
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    console.error('remote-control: save error', error);
    stateError = 'Could not save remote control pairings.';
    publishState();
    throw new Error(stateError, { cause: error });
  }
};

const queuePersistedStateOperation = (operation) => {
  const queued = persistedStateQueue.catch(() => {}).then(operation);
  persistedStateQueue = queued;
  return queued;
};

const savePersistedState = () => queuePersistedStateOperation(() => writePersistedState());

/**
 * Run a credential mutation and its durable write as one serialized unit.
 * `canStart` and `canCommit` are checked on opposite sides of the write so an
 * async owner (for example a pairing channel) cannot disappear while the new
 * credential is becoming durable. `afterPersist` must remain synchronous: it
 * is the no-yield handoff between the final ownership check and success.
 */
const mutatePersistedState = ({ mutate, canStart, canCommit, afterPersist } = {}) =>
  queuePersistedStateOperation(async () => {
    if (canStart && !canStart()) return { committed: false, value: null };
    const previousDevices = hostDevices;
    const previousMachines = remoteMachines;
    const mutation = mutate();
    if (mutation?.changed === false) {
      return { committed: false, value: mutation?.value ?? null };
    }
    let persisted = false;
    try {
      await writePersistedState();
      persisted = true;
      if (canCommit && !canCommit()) {
        hostDevices = previousDevices;
        remoteMachines = previousMachines;
        await writePersistedState();
        return { committed: false, value: mutation?.value ?? null };
      }
      afterPersist?.(mutation?.value ?? null);
      return { committed: true, value: mutation?.value ?? null };
    } catch (error) {
      hostDevices = previousDevices;
      remoteMachines = previousMachines;
      // If the first write succeeded but the synchronous handoff failed, make
      // the rollback durable before releasing the operation to later callers.
      if (persisted) {
        try {
          await writePersistedState();
        } catch {}
      }
      publishState();
      throw error;
    }
  });

// ---------------------------------------------------------------------------
// State for the renderer

const localAddresses = () => {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
};

const clientStatus = (machineId) => {
  const session = clientSessions.get(machineId);
  if (!session) return { status: 'offline', error: null };
  if (session.ready) return { status: 'connected', error: null };
  if (session.connecting) return { status: 'connecting', error: null };
  return { status: session.lastError ? 'error' : 'offline', error: session.lastError };
};

export const getRemoteControlState = () => {
  if (!stateLoaded || !identity || pairingPersistenceUnavailable()) {
    return { available: false, error: stateError ?? pairingPersistenceUnavailable() };
  }
  const connectedDeviceIds = [...hostSessions]
    .filter((session) => session.ready)
    .map((session) => session.deviceId);
  return {
    available: true,
    error: stateError,
    machineId: identity.machineId,
    machineName: identity.machineName,
    authenticated: Boolean(currentUserId),
    connectionMode: settings.connectionMode,
    host: {
      enabled: Boolean(settings.enabled && settings.allowIncoming),
      listening,
      port: listeningPort ?? settings.port,
      addresses: listening ? localAddresses() : [],
      error: listenError,
      relay: {
        enabled: Boolean(relayListener),
        online: relayOnline,
        error: relayError,
      },
      pairing:
        pairing && pairing.expiresAt > Date.now()
          ? { code: pairing.code, expiresAt: new Date(pairing.expiresAt).toISOString() }
          : null,
      devices: hostDevices.map((device) => ({
        id: device.id,
        name: device.name,
        pairedAt: device.pairedAt,
        lastSeenAt: device.lastSeenAt,
        connected: connectedDeviceIds.includes(device.id),
      })),
    },
    machines: remoteMachines.map((machine) => ({
      id: machine.id,
      name: machine.name,
      host: machine.host,
      port: machine.port,
      relay: machine.relay === true,
      pairedAt: machine.pairedAt,
      ...clientStatus(machine.id),
    })),
  };
};

const publishState = () => {
  deps?.broadcast?.('remote:state', getRemoteControlState());
};

// ---------------------------------------------------------------------------
// Reconcile: settings + account decide what runs.

const clearAccountExpiryTimer = () => {
  if (accountExpiryTimer) clearTimeout(accountExpiryTimer);
  accountExpiryTimer = null;
};

const scheduleAccountExpiry = (expiresAt) => {
  clearAccountExpiryTimer();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || shuttingDown) return;
  // Node clamps larger delays to 1 ms. Wake at the largest supported delay
  // and reconcile again for sessions whose expiry is more than ~25 days out.
  const delay = Math.min(expiresAt - Date.now() + 1, 2_147_483_647);
  accountExpiryTimer = setTimeout(() => {
    accountExpiryTimer = null;
    void reconcile();
  }, delay);
  accountExpiryTimer.unref?.();
};

const refreshAccount = async () => {
  const generation = accountGeneration;
  let session = null;
  try {
    session = await deps.readSession();
  } catch {
    session = null;
  }
  // A synchronous account transition supersedes every read that was already
  // in flight. In particular, a stale pre-sign-out read may never restore the
  // old user after notifyRemoteControlAccountChanged(null) tore it down.
  if (generation !== accountGeneration) return null;
  applyAccountSession(session);
  return currentUserId ? session : null;
};

const applyAccountSession = (session) => {
  const previousUserId = currentUserId;
  const hasExpiry = session?.expiresAt !== null && session?.expiresAt !== undefined;
  const expiresAt = hasExpiry ? Date.parse(session.expiresAt) : null;
  const validExpiry = !hasExpiry || (Number.isFinite(expiresAt) && expiresAt > Date.now());
  currentUserId = session?.token && validExpiry ? session?.user?.id ?? null : null;
  if (currentUserId && expiresAt !== null) scheduleAccountExpiry(expiresAt);
  else clearAccountExpiryTimer();
  if (currentUserId !== previousUserId) teardownForAccountChange();
};

// ---------------------------------------------------------------------------
// Relay (internet mode). Every function below is only ever reached while
// settings.connectionMode === 'relay'; in 'direct' mode the engine issues no
// request of any kind to the relay or to the relay APIs.

/** True when this build was given the deps needed to talk to Orion Cloud. */
const relaySupported = () => typeof deps?.mintRelayTicket === 'function';

const relayEnabled = () => settings.connectionMode === 'relay' && relaySupported();

/**
 * Registration announces "this machine belongs to my account and can be
 * reached at the relay". It is not pairing and confers no control: a
 * controller still needs the paired device secret to get past the handshake.
 */
const ensureRelayRegistration = async (signal) => {
  if (!currentUserId) throw new Error('Sign in to your Durango account first.');
  if (relayRegisteredFor === currentUserId) return;
  const registrationUserId = currentUserId;
  const registrationGeneration = accountGeneration;
  if (typeof deps?.registerRelayDevice === 'function') {
    await deps.registerRelayDevice({
      machineId: identity.machineId,
      name: identity.machineName,
      platform: process.platform,
      appVersion: deps.getAppVersion?.() ?? null,
      signal,
    });
  }
  if (signal?.aborted) throw new Error('The relay registration request was cancelled.');
  if (
    registrationGeneration !== accountGeneration ||
    registrationUserId !== currentUserId
  ) {
    throw new Error('The Durango account changed during relay registration.');
  }
  relayRegisteredFor = registrationUserId;
};

/**
 * Remove this machine from the account's machine list at Orion Cloud. This is
 * the explicit revoke: merely turning internet mode off keeps the machine
 * registered (it just shows offline), so a controller's list stays stable.
 * Stops the relay listener first so a ticket-mint reconnect cannot re-register
 * the row in the same breath.
 */
export const deregisterRelayMachine = async () => {
  if (!identity) return { ok: false, error: stateError ?? 'Remote control is unavailable on this machine.' };
  if (!currentUserId) return { ok: false, error: 'Sign in to your Durango account first.' };
  if (typeof deps?.deregisterRelayDevice !== 'function') {
    return { ok: false, error: 'This build cannot manage Durango Cloud registrations.' };
  }
  // Leave relay mode in the engine's own settings copy as well: the renderer
  // sends its matching configure({connectionMode:'direct'}) asynchronously,
  // and a reconcile triggered in between (account refresh, expiry timer)
  // must not restart the listener and re-register the row we are deleting.
  settings = { ...settings, connectionMode: 'direct' };
  stopRelayListener();
  closeRelaySessions('This machine was removed from Durango Cloud.');
  relayRegisteredFor = null;
  try {
    await deps.deregisterRelayDevice({ machineId: identity.machineId });
  } catch (error) {
    publishState();
    return { ok: false, error: error?.message ?? String(error) };
  }
  publishState();
  return { ok: true };
};

/**
 * Mint a short-lived, single-socket relay ticket. Tickets are the ONLY
 * credential that ever reaches the relay — never the desktop account bearer
 * token, and never anything a peer sends us.
 */
const mintHostRelayTicket = async (signal) => {
  await ensureRelayRegistration(signal);
  if (signal?.aborted) throw new Error('The relay ticket request was cancelled.');
  return deps.mintRelayTicket({ role: 'host', machineId: identity.machineId, signal });
};

const startRelayListener = () => {
  if (relayListener || shuttingDown) return;
  relayError = null;
  relayOnline = false;
  relayListener = createRelayListener({
    getTicket: (_role, { signal } = {}) => mintHostRelayTicket(signal),
    // Identical entry point to an accepted TCP socket — same caps, same
    // pre-auth frame budget, same rate limiting, same confirm-stage recheck.
    onStream: (transport) => handleInboundConnection(transport, { ip: RELAY_SOURCE }),
    onStatus: ({ online, error }) => {
      relayOnline = online;
      relayError = error ?? null;
      publishState();
    },
  });
  relayListener.start();
};

const stopRelayListener = () => {
  const active = relayListener;
  relayListener = null;
  relayOnline = false;
  relayError = null;
  // Forget the cached registration so the next start re-POSTs it. The upsert
  // is idempotent and revives a soft-deleted row — without this, a machine
  // removed at Orion Cloud (or whose name/version changed) stays wrong until
  // the app restarts or the account changes.
  relayRegisteredFor = null;
  active?.stop();
};

const cancelOutboundPairingAttempts = (reason, { relayOnly = false } = {}) => {
  for (const attempt of outboundPairingAttempts) {
    if (relayOnly && attempt.route !== 'relay') continue;
    attempt.cancelledReason = reason;
    attempt.abortController?.abort(new Error(reason));
    attempt.channel?.destroy(new Error(reason));
  }
};

const closeRelaySessions = (reason) => {
  for (const session of [...inboundConnections]) {
    if (session.transportKind === 'relay') {
      session.abortController?.abort(new Error(reason));
      session.channel.destroy(new Error(reason));
    }
  }
  for (const [machineId, session] of clientSessions) {
    if (session.route === 'relay') closeClientSession(machineId, reason);
  }
  cancelOutboundPairingAttempts(reason, { relayOnly: true });
};

const reconcile = () => {
  reconcileQueue = reconcileQueue
    .catch(() => {})
    .then(async () => {
      if (shuttingDown) return;
      // No identity means the pairing file could not be read: refuse to
      // listen or connect rather than operate on half-loaded state.
      if (!stateLoaded || !identity) return;
      await refreshAccount();
      // refreshAccount can outlive will-quit. Re-check the terminal guard
      // before consulting settings or opening any socket.
      if (shuttingDown) {
        stopServer();
        cancelOutboundPairingAttempts('Shutting down.');
        for (const [machineId] of clientSessions) closeClientSession(machineId, 'Shutting down.');
        return;
      }
      if (pairingPersistenceUnavailable()) {
        stateError = pairingPersistenceUnavailable();
        stopServer();
        stopRelayListener();
        cancelOutboundPairingAttempts('Remote control persistence is unavailable.');
        for (const [machineId] of clientSessions) {
          closeClientSession(machineId, 'Remote control persistence is unavailable.');
        }
        publishState();
        return;
      }
      const shouldListen = Boolean(settings.enabled && settings.allowIncoming && currentUserId);
      if (!shouldListen) {
        stopServer();
      } else if (!server || listeningPort !== settings.port) {
        stopServer();
        await startServer(settings.port);
      }
      // The relay is held only while this machine is actually offering itself
      // to be controlled, over the internet, on a live account.
      if (shouldListen && relayEnabled()) startRelayListener();
      else stopRelayListener();
      if (!relayEnabled()) closeRelaySessions('Internet mode is off.');
      if (!settings.enabled || !currentUserId) {
        cancelOutboundPairingAttempts('Remote control is off.');
        for (const [machineId] of clientSessions) closeClientSession(machineId, 'Remote control is off.');
      }
      publishState();
    });
  return reconcileQueue;
};

export const initRemoteControl = async (dependencies) => {
  deps = dependencies;
  shuttingDown = false;
  await loadPersistedState();
  await applyPendingUserIdMigrations();
  await reconcile();
};

export const configureRemoteControl = async (value) => {
  if (shuttingDown) return { ok: false, error: 'Remote control is shutting down.' };
  const previousConnectionMode = settings.connectionMode;
  const port = Number.isInteger(value?.port) && value.port >= 1024 && value.port <= 65535
    ? value.port
    : DEFAULT_REMOTE_PORT;
  settings = {
    enabled: value?.enabled === true,
    allowIncoming: value?.allowIncoming === true,
    port,
    // Anything but an explicit 'relay' means LAN/VPN only. Defaulting the
    // other way — treating an unknown value as internet — would silently opt a
    // machine into being reachable from outside its network.
    connectionMode: value?.connectionMode === 'relay' ? 'relay' : 'direct',
  };
  // Settings change synchronously, while account reconciliation has an await.
  // Enforce inbound opt-outs at that boundary so no listener, handshake, or
  // established controller survives until readSession happens to finish.
  if (!settings.enabled || !settings.allowIncoming) {
    stopServer();
    stopRelayListener();
  }
  if (!settings.enabled) {
    cancelOutboundPairingAttempts('Remote control is off.');
    // Outbound sessions can already have a run/stop request waiting on the
    // host renderer. Close them at the synchronous settings boundary so a
    // stalled account refresh cannot leave that command claimable after the
    // user has disabled Remote Control.
    for (const [machineId] of clientSessions) {
      closeClientSession(machineId, 'Remote control is off.');
    }
  }
  if (previousConnectionMode === 'relay' && settings.connectionMode === 'direct') {
    stopRelayListener();
    closeRelaySessions('Internet mode is off.');
  }
  await reconcile();
  return { ok: true };
};

export const notifyRemoteControlAccountChanged = (session, { reconcile: shouldReconcile = true } = {}) => {
  if (shuttingDown) return;
  if (session !== undefined) {
    accountGeneration += 1;
    applyAccountSession(session);
    publishState();
  }
  if (!deps || !shouldReconcile) return;
  void reconcile();
};

export const shutdownRemoteControl = () => {
  shuttingDown = true;
  clearAccountExpiryTimer();
  stopServer();
  stopRelayListener();
  cancelOutboundPairingAttempts('Shutting down.');
  for (const [machineId] of clientSessions) closeClientSession(machineId, 'Shutting down.');
  cancelPendingRendererCommands('Remote control is shutting down.');
};

// Durango identity cutover: the account's native Clerk id (`session.user.id`)
// changes while the desktop session (and the app user id behind it) does not.
// Every stored pairing carries the account id it was made under — controllers
// this host accepted and hosts this controller can drive are always the same
// account — so without this, existing pairings would stop matching the
// refreshed account and users would have to re-pair every machine.
let pendingUserIdMigrations = [];

const rewritePairingUserIds = (fromUserId, toUserId) => {
  let changed = 0;
  const rewrite = (entry) => {
    if (entry.userId !== fromUserId) return entry;
    changed += 1;
    return { ...entry, userId: toUserId };
  };
  // Copies, not in-place writes: mutatePersistedState rolls back by restoring
  // the previous array references if the durable write fails.
  hostDevices = hostDevices.map(rewrite);
  remoteMachines = remoteMachines.map(rewrite);
  return changed;
};

/**
 * Rebind stored pairings from the account's previous user id to its current
 * one. Only call this for the SAME signed-in session whose `user.id` changed
 * (GET /api/desktop-auth/session returned a different id for the same token);
 * a different account signing in must never inherit pairings. Safe to call
 * before init: the rewrite is applied right after the pairing file loads.
 */
export const migrateRemoteControlUserId = async ({ fromUserId, toUserId } = {}) => {
  if (typeof fromUserId !== 'string' || typeof toUserId !== 'string') return { migrated: 0 };
  if (!fromUserId || !toUserId || fromUserId === toUserId) return { migrated: 0 };
  if (!stateLoaded) {
    pendingUserIdMigrations.push({ fromUserId, toUserId });
    return { migrated: 0, deferred: true };
  }
  if (!identity) return { migrated: 0 };
  try {
    const result = await mutatePersistedState({
      mutate: () => {
        const changed = rewritePairingUserIds(fromUserId, toUserId);
        return { changed: changed > 0, value: changed };
      },
      afterPersist: () => publishState(),
    });
    return { migrated: result.committed ? result.value : 0 };
  } catch (error) {
    return { migrated: 0, error: error?.message ?? String(error) };
  }
};

const applyPendingUserIdMigrations = async () => {
  const migrations = pendingUserIdMigrations;
  pendingUserIdMigrations = [];
  for (const migration of migrations) {
    await migrateRemoteControlUserId(migration);
  }
};

/** Drain credential mutations before Electron is allowed to terminate. */
export const waitForRemoteControlPersistence = () => persistedStateQueue.then(() => undefined, () => undefined);

// ---------------------------------------------------------------------------
// Host side: TCP server, relay listener, pairing, inbound sessions.

/**
 * Is this machine currently offering itself for control at all? Used as the
 * confirm-stage liveness check, so a connection parked mid-handshake cannot
 * outlive the listener being switched off — over either transport.
 */
const hostAcceptingConnections = () => listening || Boolean(relayListener);

const registerHandshakeFailure = (ip) => {
  if (!ip) return;
  const now = Date.now();
  // Sweep expired entries so a rotating source range can't grow the map for
  // the life of the process.
  for (const [key, value] of handshakeFailures) {
    if (value.resetAt <= now) handshakeFailures.delete(key);
  }
  const entry = handshakeFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    handshakeFailures.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS });
  } else {
    entry.count += 1;
  }
};

const isRateLimited = (ip) => {
  if (!ip) return false;
  const entry = handshakeFailures.get(ip);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    handshakeFailures.delete(ip);
    return false;
  }
  return entry.count >= FAIL_LIMIT;
};

// Resolves once the listener is up (or has failed) so a configure → pair
// sequence never races the async bind.
const startServer = (port) =>
  new Promise((resolve) => {
    if (shuttingDown) {
      resolve();
      return;
    }
    listenError = null;
    const createdServer = net.createServer((socket) =>
      handleInboundConnection(wrapTcpSocket(socket), { ip: socket.remoteAddress ?? null })
    );
    server = createdServer;
    createdServer.maxConnections = MAX_INBOUND_CONNECTIONS;
    createdServer.on('error', (error) => {
      listenError = error?.message ?? String(error);
      listening = false;
      listeningPort = null;
      try {
        createdServer.close();
      } catch {}
      if (server === createdServer) server = null;
      publishState();
      resolve();
    });
    createdServer.listen(port, () => {
      // stopServer may have cleared the global reference while bind was still
      // pending. Close this exact server rather than consulting that now-null
      // reference, or it can survive shutdown as an orphan listener.
      if (shuttingDown || server !== createdServer) {
        try {
          createdServer.close();
        } catch {}
        if (server === createdServer) server = null;
        resolve();
        return;
      }
      listening = true;
      listeningPort = port;
      listenError = null;
      publishState();
      resolve();
    });
  });

const stopServer = () => {
  hostAuthorizationGeneration += 1;
  cancelPendingRendererCommands('Incoming remote control stopped.', { unclaimedOnly: true });
  const activeServer = server;
  server = null;
  if (activeServer) {
    try {
      activeServer.close();
    } catch {}
  }
  listening = false;
  listeningPort = null;
  // Every inbound connection, handshaking ones included — server.close() only
  // stops new accepts, it does not touch sockets already open.
  for (const session of [...inboundConnections]) {
    session.abortController?.abort(new Error('Incoming remote control stopped.'));
    session.channel.destroy();
  }
  inboundConnections.clear();
  hostSessions.clear();
  cancelRemotePairing();
};

const teardownForAccountChange = () => {
  relayRegisteredFor = null;
  stopServer();
  stopRelayListener();
  cancelOutboundPairingAttempts('The Durango account changed.');
  for (const [machineId] of clientSessions) {
    closeClientSession(machineId, 'The Durango account changed.');
  }
  cancelPendingRendererCommands('The Durango account changed.');
};

export const startRemotePairing = () => {
  if (!identity) {
    return { ok: false, error: stateError ?? 'Remote control is unavailable on this machine.' };
  }
  if (!hostAcceptingConnections()) {
    return { ok: false, error: 'Enable remote control first.' };
  }
  if (!currentUserId) {
    return { ok: false, error: 'Sign in to your Durango account first.', needsAuth: true };
  }
  try {
    requirePairingPersistence();
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  cancelRemotePairing();
  const code = generatePairingCode();
  const nextPairing = {
    code,
    psk: pairingCodeToPsk(code),
    expiresAt: Date.now() + PAIRING_TTL_MS,
    attempts: 0,
    timer: null,
  };
  nextPairing.timer = setTimeout(() => {
    if (pairing === nextPairing) cancelRemotePairing();
  }, PAIRING_TTL_MS);
  pairing = nextPairing;
  publishState();
  return {
    ok: true,
    code,
    expiresAt: new Date(pairing.expiresAt).toISOString(),
    addresses: localAddresses(),
    port: listeningPort,
  };
};

export const cancelRemotePairing = ({ preserveSession = null } = {}) => {
  if (pairing?.timer) clearTimeout(pairing.timer);
  const hadPairing = Boolean(pairing);
  pairing = null;
  // Pairing proof verification belongs to the exact live code/session. Code
  // cancellation, expiry, or replacement must stop stale Cloud work instead
  // of merely making its eventual result unusable.
  for (const session of [...inboundConnections]) {
    if (session === preserveSession || session.mode !== 'pair') continue;
    session.abortController?.abort(new Error('The pairing code was cancelled.'));
    session.channel.destroy(new Error('The pairing code was cancelled.'));
  }
  if (hadPairing) publishState();
  return { ok: true };
};

export const revokeRemoteDevice = async ({ deviceId } = {}) => {
  if (shuttingDown) return { ok: false, error: 'Remote control is shutting down.' };
  try {
    requirePairingPersistence();
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  const id = String(deviceId ?? '');
  let outcome;
  try {
    outcome = await mutatePersistedState({
      mutate: () => {
        const nextDevices = hostDevices.filter((device) => device.id !== id);
        if (nextDevices.length === hostDevices.length) {
          return { changed: false, value: { found: false } };
        }
        hostDevices = nextDevices;
        return { value: { found: true } };
      },
    });
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  if (!outcome.value?.found) return { ok: false, error: 'Device not found.' };
  retireHostDeviceAuthorization(id, 'This controlling device was revoked.');
  publishState();
  return { ok: true };
};

const activePairing = () => {
  if (!pairing) return null;
  if (pairing.expiresAt <= Date.now()) {
    cancelRemotePairing();
    return null;
  }
  return pairing;
};

/**
 * Charge a failed code guess against the attempt cap. Only wrong-MAC failures
 * count: a peer that merely opens a connection proves nothing, and counting
 * those would let anyone on the network burn every code the user generates.
 */
const consumePairingAttempt = (challengedPsk) => {
  // Only the code this connection actually challenged may be charged. Without
  // the identity check, a socket that said hello during code A's window but
  // confirmed after the user regenerated would burn code B instead.
  if (!pairing || !challengedPsk || challengedPsk !== pairing.psk) return;
  pairing.attempts += 1;
  if (pairing.attempts >= PAIRING_MAX_ATTEMPTS) cancelRemotePairing();
};

const isActivePairingChallenge = (session) =>
  Boolean(
    pairing &&
    pairing.expiresAt > Date.now() &&
    session.challengedPairingPsk &&
    macsEqual(pairing.psk, session.challengedPairingPsk)
  );

const validHello = (message) =>
  message?.t === 'hello' &&
  message.v === REMOTE_PROTOCOL_VERSION &&
  (message.mode === 'pair' || message.mode === 'session') &&
  typeof message.pub === 'string' &&
  message.pub.length <= 256 &&
  typeof message.nonce === 'string' &&
  message.nonce.length <= 128 &&
  (message.mode === 'pair' || (typeof message.deviceId === 'string' && message.deviceId.length <= 128));

const inboundCountForIp = (ip) => {
  let count = 0;
  for (const session of inboundConnections) {
    if (session.ip === ip) count += 1;
  }
  return count;
};

/**
 * The single inbound entry point, shared by accepted TCP sockets and relay
 * streams. `transport` is whichever pipe carried the connection; nothing below
 * this line knows or cares which, and no relay-supplied value influences
 * authentication.
 */
const handleInboundConnection = (transport, { ip = null } = {}) => {
  if (
    isRateLimited(ip) ||
    inboundConnections.size >= MAX_INBOUND_CONNECTIONS ||
    inboundCountForIp(ip) >= MAX_INBOUND_PER_IP
  ) {
    transport.destroy();
    return;
  }
  const channel = new SecureChannel(transport, { maxFrame: HANDSHAKE_FRAME_BYTES });
  const session = {
    channel,
    abortController: new AbortController(),
    ip,
    transportKind: transport.kind ?? 'unknown',
    mode: null,
    deviceId: null,
    device: null,
    ready: false,
    stage: 'hello',
    eph: null,
    helloRaw: null,
    keys: null,
    transcript: null,
    authRealPsk: false,
    challengedPairingPsk: null,
    threadTransfer: null,
  };
  // A peer that opens a slot and then says nothing is as much of an abuse as a
  // bad MAC — it just costs the attacker less. Count it, so repeat offenders
  // hit the per-IP rate limit instead of holding the connection cap forever.
  const handshakeTimer = setTimeout(() => {
    registerHandshakeFailure(ip);
    channel.destroy();
  }, HANDSHAKE_TIMEOUT_MS);
  inboundConnections.add(session);

  channel.onClose(() => {
    clearTimeout(handshakeTimer);
    clearThreadTransfer(session);
    session.abortController.abort(new Error('The remote session closed.'));
    inboundConnections.delete(session);
    cancelPendingRendererCommands('The controlling device disconnected.', {
      unclaimedOnly: true,
      session,
    });
    if (hostSessions.delete(session) && session.ready) publishState();
  });

  channel.onMessage((message, raw) => {
    if (session.stage === 'hello') {
      if (!validHello(message)) {
        registerHandshakeFailure(ip);
        channel.destroy();
        return;
      }
      session.mode = message.mode;
      session.helloRaw = Buffer.from(raw);
      let psk = null;
      if (message.mode === 'pair') {
        const current = activePairing();
        if (current) {
          psk = current.psk;
          session.authRealPsk = true;
          // Remember which code this connection was challenged against, so a
          // later failure charges that code and not its replacement.
          session.challengedPairingPsk = current.psk;
        }
      } else {
        session.deviceId = message.deviceId;
        session.device = hostDevices.find((device) => device.id === message.deviceId) ?? null;
        if (session.device && currentUserId && session.device.userId === currentUserId) {
          psk = Buffer.from(session.device.secret, 'base64');
          session.authRealPsk = true;
        }
      }
      // Unknown device / no active pairing: continue with a random PSK so the
      // failure is indistinguishable from a wrong secret (no enumeration).
      if (!psk) psk = crypto.randomBytes(32);

      session.eph = createEphemeralKeyPair();
      const peerPublicDer = Buffer.from(message.pub, 'base64');
      const ackRaw = channel.send({
        t: 'helloAck',
        v: REMOTE_PROTOCOL_VERSION,
        pub: session.eph.publicDer.toString('base64'),
        nonce: crypto.randomBytes(16).toString('base64'),
      });
      if (!ackRaw) return;
      session.transcript = handshakeTranscript(session.helloRaw, ackRaw);
      try {
        session.keys = deriveHandshakeKeys({
          privateKey: session.eph.privateKey,
          peerPublicDer,
          psk,
          transcript: session.transcript,
          isClient: false,
        });
      } catch {
        registerHandshakeFailure(ip);
        channel.destroy();
        return;
      }
      session.stage = 'confirm';
      return;
    }

    if (session.stage === 'confirm') {
      const expected = confirmationMac(session.keys.macKey, 'client', session.transcript);
      let received = null;
      try {
        received = Buffer.from(String(message?.mac ?? ''), 'base64');
      } catch {}
      if (!session.authRealPsk || !received || !macsEqual(expected, received)) {
        registerHandshakeFailure(ip);
        // Charge the attempt cap only for a genuine guess at a live code:
        // authRealPsk means a pairing was active when this connection said
        // hello, so the host answered with the real code's PSK and the peer
        // got it wrong. Without that condition, connections parked BEFORE the
        // user ever pressed "Generate code" could burn the new code seconds
        // after it appears.
        if (session.mode === 'pair') consumePairingAttempt(session.challengedPairingPsk);
        channel.destroy();
        return;
      }
      // The PSK was chosen at hello; re-authorize against live state before
      // promoting. A connection parked between hello and confirm must not
      // survive a revoke, a sign-out, or the listener being turned off — none
      // of which can reach a session that is not yet in hostSessions.
      if (session.mode === 'session') {
        const device = hostDevices.find((candidate) => candidate.id === session.deviceId);
        if (!hostAcceptingConnections() || !currentUserId || !device || device.userId !== currentUserId) {
          channel.destroy();
          return;
        }
        session.device = device;
      } else if (!hostAcceptingConnections() || !currentUserId || !isActivePairingChallenge(session)) {
        channel.destroy();
        return;
      }
      channel.send({
        t: 'confirm',
        mac: confirmationMac(session.keys.macKey, 'server', session.transcript).toString('base64'),
      });
      channel.enableEncryption(session.keys);
      // Authenticated: allow full-size frames (thread transcripts).
      channel.setMaxFrame(MAX_FRAME_BYTES);
      clearTimeout(handshakeTimer);
      session.stage = session.mode === 'pair' ? 'pairing' : 'established';
      if (session.mode === 'pair') {
        // Same-account authorization is separate from possession of the
        // pairing code. Bind the controller's short-lived Orion Cloud proof
        // to this connection and this host so it cannot be replayed against a
        // different pairing session or used as an account bearer credential.
        session.accountChallenge = crypto.randomBytes(32).toString('base64url');
        channel.send({
          t: 'pairChallenge',
          host: { id: identity.machineId, name: identity.machineName },
          challenge: session.accountChallenge,
        });
      } else {
        session.ready = true;
        session.device.lastSeenAt = new Date().toISOString();
        void savePersistedState().catch(() => {});
        hostSessions.add(session);
        channel.send({
          t: 'welcome',
          machine: { id: identity.machineId, name: identity.machineName },
          userId: currentUserId,
          appVersion: deps.getAppVersion?.() ?? null,
        });
        publishState();
      }
      return;
    }

    if (session.stage === 'pairing') {
      void handlePairRequest(session, message);
      return;
    }

    if (session.stage === 'established') {
      void handleHostRequest(session, message);
    }
  });
};

const handlePairRequest = async (session, message) => {
  const ownsPairingSession = () =>
    inboundConnections.has(session) &&
    session.stage === 'pairing' &&
    hostAcceptingConnections() &&
    Boolean(currentUserId) &&
    isActivePairingChallenge(session);
  const fail = (error) => {
    if (!inboundConnections.has(session)) return;
    session.channel.send({ t: 'res', reqId: message?.reqId ?? null, ok: false, error });
    session.channel.close();
  };
  if (message?.t !== 'pair') return fail('Unexpected message.');
  const deviceId = String(message?.device?.id ?? '');
  const deviceName = String(message?.device?.name ?? '').slice(0, 120) || 'Unknown device';
  const accountProof = String(message?.accountProof ?? '');
  if (!deviceId || deviceId.length > 128) return fail('Invalid device id.');
  if (!accountProof || accountProof.length > 16_384 || !session.accountChallenge) {
    return fail('The controller did not provide a valid Durango account proof.');
  }
  let controllerUserId = null;
  try {
    controllerUserId = await deps.verifyRemotePairingProof({
      proof: accountProof,
      challenge: session.accountChallenge,
      machineId: identity.machineId,
      signal: session.abortController.signal,
    });
  } catch {}
  if (!ownsPairingSession()) return;
  await refreshAccount();
  if (!ownsPairingSession()) return;
  if (!currentUserId) return fail('The host is signed out.');
  if (!controllerUserId || controllerUserId !== currentUserId) {
    return fail('Both machines must be signed in to the same Durango account.');
  }
  if (deviceId === identity.machineId) return fail('A machine cannot pair with itself.');
  try {
    requirePairingPersistence();
  } catch (error) {
    return fail(error?.message ?? String(error));
  }

  const secret = crypto.randomBytes(32).toString('base64');
  const pairingUserId = currentUserId;
  const stillOwnsPairing = () => ownsPairingSession() && currentUserId === pairingUserId;
  let outcome;
  try {
    outcome = await mutatePersistedState({
      canStart: stillOwnsPairing,
      canCommit: stillOwnsPairing,
      mutate: () => {
        hostDevices = hostDevices.filter((device) => device.id !== deviceId);
        hostDevices.push({
          id: deviceId,
          name: deviceName,
          userId: pairingUserId,
          secret,
          pairedAt: new Date().toISOString(),
          lastSeenAt: null,
        });
      },
      // No await may separate the final ownership check, delivery of the
      // credential, and retirement of the single-use code.
      afterPersist: () => {
        // The replacement is durable now. Retire every session and unclaimed
        // renderer command authorized by the previous device secret before
        // handing the new secret to this pairing connection.
        retireHostDeviceAuthorization(deviceId, 'This controlling device was paired again.');
        session.channel.send({
          t: 'res',
          reqId: message?.reqId ?? null,
          ok: true,
          host: { id: identity.machineId, name: identity.machineName },
          userId: pairingUserId,
          secret,
        });
        cancelRemotePairing({ preserveSession: session });
        session.channel.close();
      },
    });
  } catch (error) {
    return fail(error?.message ?? String(error));
  }
  if (!outcome.committed) return;
  publishState();
};

// Renderer command bridge (host side): remote runTurn/stopTurn are executed by
// the host's renderer exactly like local user actions, so the host UI and
// store stay authoritative. Same shape as the orchestration spawnRequest flow.
const currentHostSessionDevice = (session) => {
  const device = hostDevices.find((candidate) => candidate.id === session?.deviceId);
  if (
    !settings.enabled ||
    !settings.allowIncoming ||
    !currentUserId ||
    !hostAcceptingConnections() ||
    !session?.ready ||
    session.channel?.closed ||
    !hostSessions.has(session) ||
    !device ||
    device !== session.device ||
    device.userId !== currentUserId
  ) {
    return null;
  }
  return device;
};

const hostDeviceAuthorizationGeneration = (deviceId) =>
  hostDeviceAuthorizationGenerations.get(deviceId) ?? 0;

const pendingRendererCommandIsAuthorized = (pending) => {
  const { authorization } = pending;
  const device = currentHostSessionDevice(authorization?.session);
  return Boolean(
    device &&
    authorization.hostGeneration === hostAuthorizationGeneration &&
    authorization.deviceGeneration === hostDeviceAuthorizationGeneration(device.id)
  );
};

const settlePendingRendererCommand = (commandId, pending, result) => {
  if (pendingRendererCommands.get(commandId) !== pending) return false;
  pendingRendererCommands.delete(commandId);
  clearTimeout(pending.timer);
  pending.resolve(result);
  return true;
};

const cancelPendingRendererCommands = (
  error,
  { unclaimedOnly = false, session = null, deviceId = null } = {}
) => {
  for (const [commandId, pending] of pendingRendererCommands) {
    if (unclaimedOnly && pending.claimed) continue;
    if (session && pending.authorization?.session !== session) continue;
    if (deviceId && pending.authorization?.deviceId !== deviceId) continue;
    settlePendingRendererCommand(commandId, pending, { ok: false, error });
  }
};

export const notifyRemoteCommandRendererLost = () => {
  cancelPendingRendererCommands(
    'Open a Durango Code window on the host to run remote commands.',
    { unclaimedOnly: true }
  );
};

const retireHostDeviceAuthorization = (deviceId, reason) => {
  hostDeviceAuthorizationGenerations.set(
    deviceId,
    hostDeviceAuthorizationGeneration(deviceId) + 1
  );
  cancelPendingRendererCommands(reason, { unclaimedOnly: true, deviceId });
  // Includes established sessions and connections parked between hello and
  // confirm. Rotation/revocation retires the old credential everywhere.
  for (const session of [...inboundConnections]) {
    if (session.deviceId === deviceId) session.channel.destroy(new Error(reason));
  }
};

const requestRendererCommand = (command, timeoutMs, session, onClaim = null) => {
  const device = currentHostSessionDevice(session);
  if (!device) {
    return Promise.resolve({ ok: false, error: 'The controlling device is no longer authorized.' });
  }
  const commandId = crypto.randomUUID();
  const expiresAt = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingRendererCommands.get(commandId);
      if (pending) {
        settlePendingRendererCommand(commandId, pending, {
          ok: false,
          error: 'The host did not respond in time.',
        });
      }
    }, timeoutMs);
    timer.unref?.();
    const pending = {
      resolve,
      timer,
      claimed: false,
      onClaim,
      authorization: {
        session,
        deviceId: device.id,
        hostGeneration: hostAuthorizationGeneration,
        deviceGeneration: hostDeviceAuthorizationGeneration(device.id),
      },
    };
    pendingRendererCommands.set(commandId, pending);
    const delivered = deps.dispatchRendererCommand({ commandId, expiresAt, command });
    // On macOS the app remains alive after its last window closes. Reject
    // immediately when broadcast had no renderer recipient instead of leaving
    // the controller waiting for the command timeout.
    if (delivered === 0 && pendingRendererCommands.get(commandId) === pending) {
      settlePendingRendererCommand(commandId, pending, {
        ok: false,
        error: 'Open a Durango Code window on the host to run remote commands.',
      });
    }
  });
};

// A run command may spend most of its timeout downloading linked-task media or
// preparing an embedded terminal. The renderer atomically claims ownership
// immediately before it starts the actual turn. Once claimed, the startup
// deadline can no longer report a timeout before that start; a shorter result
// deadline still protects against a renderer disappearing mid-response.
export const claimRemoteCommand = ({ commandId } = {}) => {
  const pending = pendingRendererCommands.get(commandId);
  if (!pending || pending.claimed) return { ok: false };
  if (!pendingRendererCommandIsAuthorized(pending)) {
    settlePendingRendererCommand(commandId, pending, {
      ok: false,
      error: 'The controlling device is no longer authorized.',
    });
    return { ok: false };
  }
  pending.claimed = true;
  clearTimeout(pending.timer);
  const completionTimeoutMs = Number.isFinite(deps?.rendererCommandCompletionTimeoutMs)
    ? Math.max(1, deps.rendererCommandCompletionTimeoutMs)
    : REQUEST_TIMEOUT_MS;
  pending.timer = setTimeout(() => {
    if (pendingRendererCommands.get(commandId) !== pending) return;
    pendingRendererCommands.delete(commandId);
    pending.resolve({ ok: false, error: 'The host did not confirm the remote command in time.' });
  }, completionTimeoutMs);
  pending.timer.unref?.();
  try {
    pending.onClaim?.(completionTimeoutMs);
  } catch {}
  return { ok: true };
};

export const resolveRemoteCommand = (payload) => {
  const pending = pendingRendererCommands.get(payload?.commandId);
  if (!pending) return { ok: false };
  settlePendingRendererCommand(payload.commandId, pending, {
    ok: payload?.ok === true,
    threadId: typeof payload?.threadId === 'string' ? payload.threadId : undefined,
    epicId: typeof payload?.epicId === 'string' ? payload.epicId : undefined,
    error: typeof payload?.error === 'string' ? payload.error : undefined,
  });
  return { ok: true };
};

const buildSnapshot = async () => {
  const state = (await deps.readStoreState()) ?? {};
  const threadIndex = deps.readThreadsIndex
    ? await deps.readThreadsIndex()
    : { entries: (await deps.readThreadsFile())?.threads ?? [] };
  const threads = Array.isArray(threadIndex?.entries) ? threadIndex.entries : [];
  return {
    machine: { id: identity.machineId, name: identity.machineName },
    capturedAt: new Date().toISOString(),
    features: {
      epics: state.epicsSettings?.enabled !== false,
    },
    // Remote clients group threads by these entries. Include the scratch
    // workspace on the wire without adding it to the host's saved projects.
    projects: [
      ...(state.noProject ? [state.noProject] : []),
      ...(Array.isArray(state.projects) ? state.projects : []),
    ].map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
    })),
    epics: (Array.isArray(state.epics) ? state.epics : []).map((epic) => ({
      id: epic.id,
      name: epic.name,
      description: epic.description ?? '',
      repositoryProjectId: epic.repositoryProjectId ?? null,
      createdAt: epic.createdAt ?? null,
      settledAt: epic.settledAt ?? null,
    })),
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      epicId: thread.epicId ?? null,
      parentThreadId: thread.parentThreadId ?? null,
      subagent: Boolean(thread.subagent),
      title: thread.title,
      status: thread.status,
      modelId: thread.modelId,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt ?? thread.messages?.at?.(-1)?.ts ?? thread.createdAt,
      messageCount: Number.isSafeInteger(thread.messageCount)
        ? thread.messageCount
        : Array.isArray(thread.messages) ? thread.messages.length : 0,
    })),
  };
};

// Kept in sync with src/app/remote-control-policy.ts (remoteThreadRuntime):
// remote turns on Claude Code CLI terminal threads are rejected there, so the
// model catalog must not offer that entry to remote controllers either.
const REMOTE_UNSUPPORTED_MODEL_ID = 'claude:claude-code-cli';

// Anything but a known access mode is dropped rather than failing the
// request, so peers with a newer option set still get their turn started.
const sanitizeAccessMode = (value) =>
  value === 'read-only' || value === 'workspace-write' || value === 'full-access'
    ? value
    : undefined;

// Provider-agnostic reasoning effort on the wire. The renderer maps it onto
// the thread field for the turn's model (codex / claude / grok). Unknown
// values are dropped so older hosts and newer controllers stay compatible.
const REASONING_EFFORTS = new Set([
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra',
  'max',
  'ultracode',
  'ultrathink',
]);
const sanitizeReasoningEffort = (value) =>
  typeof value === 'string' && REASONING_EFFORTS.has(value) ? value : undefined;

const sanitizeCodexServiceTier = (value) =>
  value === 'default' || value === 'priority' ? value : undefined;

const sanitizeClaudeContextWindow = (value) =>
  value === '200k' || value === '1m' ? value : undefined;

// Shape every entry explicitly: the discovered catalog is an internal object
// (per-provider CLI details may grow fields) and must not be serialized
// verbatim onto the wire.
const buildModelCatalog = (models) =>
  (Array.isArray(models) ? models : [])
    .filter((model) => typeof model?.id === 'string' && model.id !== REMOTE_UNSUPPORTED_MODEL_ID)
    .map((model) => ({
      id: model.id,
      providerId: String(model.providerId ?? ''),
      providerLabel: String(model.providerLabel ?? ''),
      label: String(model.label ?? ''),
      slug: String(model.slug ?? ''),
      ...(typeof model.shortcut === 'string' ? { shortcut: model.shortcut } : {}),
      ...(model.favorite === true ? { favorite: true } : {}),
      ...(Array.isArray(model.reasoningVariants)
        ? { reasoningVariants: model.reasoningVariants.filter((value) => typeof value === 'string') }
        : {}),
      ...(typeof model.available === 'boolean' ? { available: model.available } : {}),
      ...(typeof model.unavailableReason === 'string'
        ? { unavailableReason: model.unavailableReason }
        : {}),
    }));

const clearThreadTransfer = (session) => {
  const transfer = session.threadTransfer;
  if (!transfer) return;
  clearTimeout(transfer.expiryTimer);
  if (session.threadTransfer === transfer) session.threadTransfer = null;
};

const retainThreadTransfer = (session, threadId, serialized) => {
  clearThreadTransfer(session);
  const transfer = {
    threadId,
    serialized,
    version: crypto.createHash('sha256').update(serialized).digest('base64url'),
    expiryTimer: null,
  };
  transfer.expiryTimer = setTimeout(() => {
    if (session.threadTransfer === transfer) session.threadTransfer = null;
  }, THREAD_TRANSFER_TTL_MS);
  transfer.expiryTimer.unref?.();
  session.threadTransfer = transfer;
  return transfer;
};

const threadResponseFitsFrame = (reqId, serialized) =>
  Buffer.byteLength(JSON.stringify({ t: 'res', reqId, ok: true, thread: null }), 'utf8') -
    Buffer.byteLength('null', 'utf8') +
    serialized.length +
    ENCRYPTED_FRAME_OVERHEAD_BYTES <=
  MAX_FRAME_BYTES;

const handleHostRequest = async (session, message) => {
  if (!currentHostSessionDevice(session)) {
    session.channel.destroy();
    return;
  }
  const reqId =
    typeof message?.reqId === 'string' && message.reqId.length <= 128 ? message.reqId : null;
  const respond = (payload) => {
    if (!session.channel.closed) session.channel.send({ t: 'res', reqId, ...payload });
  };
  const acknowledgeClaim = (completionTimeoutMs) => {
    if (!session.channel.closed) {
      session.channel.send({ t: 'claimed', reqId, completionTimeoutMs });
    }
  };
  try {
    switch (message?.t) {
      case 'ping':
        respond({ ok: true });
        return;
      case 'snapshot':
        respond({ ok: true, snapshot: await buildSnapshot() });
        return;
      case 'models':
        respond({ ok: true, models: buildModelCatalog(await deps.listAgentModels()) });
        return;
      case 'createEpic': {
        const name = typeof message?.name === 'string' ? message.name.trim() : '';
        if (!name) {
          respond({ ok: false, error: 'Epic title is required.' });
          return;
        }
        const description =
          typeof message?.description === 'string' ? message.description.trim().slice(0, 20_000) : '';
        const projectIds = Array.isArray(message?.projectIds)
          ? [...new Set(message.projectIds.filter((value) => typeof value === 'string' && value.length <= 500))].slice(0, 32)
          : [];
        const result = await requestRendererCommand(
          {
            kind: 'createEpic',
            name: name.slice(0, 500),
            ...(description ? { description } : {}),
            ...(projectIds.length > 0 ? { projectIds } : {}),
            source: { machineId: session.deviceId, machineName: session.device?.name ?? 'Remote' },
          },
          Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS,
          session,
          acknowledgeClaim
        );
        respond(result);
        return;
      }
      case 'thread': {
        const threadId = String(message?.threadId ?? '');
        const isContinuation = message?.threadOffset !== undefined;
        if (isContinuation) {
          if (message?.threadChunking !== true) {
            respond({
              ok: false,
              error: 'This thread is too large for this version of the controller. Update Durango Code and try again.',
            });
            return;
          }
          const transfer = session.threadTransfer;
          if (
            !transfer ||
            transfer.threadId !== threadId ||
            typeof message?.threadVersion !== 'string' ||
            message.threadVersion !== transfer.version
          ) {
            respond({ ok: false, error: 'The thread transfer expired. Refresh and try again.' });
            return;
          }
          const offset = Number(message.threadOffset);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset >= transfer.serialized.length) {
            respond({ ok: false, error: 'Invalid thread chunk offset.' });
            return;
          }
          const end = Math.min(transfer.serialized.length, offset + THREAD_CHUNK_BYTES);
          respond({
            ok: true,
            threadChunk: transfer.serialized.subarray(offset, end).toString('base64'),
            threadOffset: offset,
            nextThreadOffset: end < transfer.serialized.length ? end : null,
            threadVersion: transfer.version,
            threadBytes: transfer.serialized.length,
          });
          return;
        }
        let thread = null;
        try {
          if (deps.readThreadById) {
            thread = await deps.readThreadById(threadId);
          } else {
            const threadsFile = await deps.readThreadsFile({ threadId });
            thread = (threadsFile?.threads ?? []).find((candidate) => candidate?.id === threadId) ?? null;
          }
        } catch {}
        if (!thread) {
          respond({ ok: false, error: 'Thread not found on the host (it may not be saved yet).' });
          return;
        }
        const serialized = Buffer.from(JSON.stringify(thread), 'utf8');
        if (serialized.length > MAX_THREAD_TRANSFER_BYTES) {
          respond({ ok: false, error: 'This thread is too large to transfer safely.' });
          return;
        }
        const directPayload = { ok: true, thread };
        // Keep the original response shape for ordinary transcripts and older
        // controllers. Oversized transcripts use a pull-based byte transfer:
        // the controller requests the next chunk only after receiving this
        // one, so the host never queues the entire transcript to a slow peer.
        if (message?.threadOffset === undefined && threadResponseFitsFrame(reqId, serialized)) {
          respond(directPayload);
          return;
        }
        if (message?.threadChunking !== true) {
          respond({
            ok: false,
            error: 'This thread is too large for this version of the controller. Update Durango Code and try again.',
          });
          return;
        }
        const transfer = retainThreadTransfer(session, threadId, serialized);
        const end = Math.min(serialized.length, THREAD_CHUNK_BYTES);
        respond({
          ok: true,
          threadChunk: serialized.subarray(0, end).toString('base64'),
          threadOffset: 0,
          nextThreadOffset: end < serialized.length ? end : null,
          threadVersion: transfer.version,
          threadBytes: serialized.length,
        });
        return;
      }
      case 'runTurn': {
        const prompt = typeof message?.prompt === 'string' ? message.prompt.trim() : '';
        if (!prompt) {
          respond({ ok: false, error: 'Empty prompt.' });
          return;
        }
        const result = await requestRendererCommand(
          {
            kind: 'runTurn',
            prompt: prompt.slice(0, 200_000),
            threadId: typeof message?.threadId === 'string' ? message.threadId : undefined,
            projectId: typeof message?.projectId === 'string' ? message.projectId : undefined,
            epicId: typeof message?.epicId === 'string' ? message.epicId : undefined,
            modelId: typeof message?.modelId === 'string' ? message.modelId : undefined,
            accessMode: sanitizeAccessMode(message?.accessMode),
            reasoningEffort: sanitizeReasoningEffort(message?.reasoningEffort),
            codexServiceTier: sanitizeCodexServiceTier(message?.codexServiceTier),
            claudeContextWindow: sanitizeClaudeContextWindow(message?.claudeContextWindow),
            source: { machineId: session.deviceId, machineName: session.device?.name ?? 'Remote' },
          },
          Number.isFinite(deps?.runTurnTimeoutMs) ? Math.max(1, deps.runTurnTimeoutMs) : RUN_TURN_TIMEOUT_MS,
          session,
          acknowledgeClaim
        );
        respond(result);
        return;
      }
      case 'stopTurn': {
        const result = await requestRendererCommand(
          {
            kind: 'stopTurn',
            threadId: String(message?.threadId ?? ''),
            source: { machineId: session.deviceId, machineName: session.device?.name ?? 'Remote' },
          },
          Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS,
          session,
          acknowledgeClaim
        );
        respond(result);
        return;
      }
      default:
        respond({ ok: false, error: 'Unsupported request.' });
    }
  } catch (error) {
    respond({ ok: false, error: error?.message ?? String(error) });
  }
};

// Host → controllers push events.
const pushToControllers = (payload) => {
  for (const session of hostSessions) {
    if (session.ready && !session.channel.closed) session.channel.send(payload);
  }
};

/** Tap of agent turn events; forwarded so controllers can follow live runs. */
export const forwardAgentEventToRemote = (event) => {
  if (hostSessions.size === 0) return;
  pushToControllers({ t: 'event', kind: 'turnEvent', payload: event });
};

/** Store or threads file changed on disk — tell controllers to refresh. */
export const notifyRemoteWorkspaceChanged = () => {
  if (hostSessions.size === 0) return;
  if (workspaceEventTimer) return;
  workspaceEventTimer = setTimeout(() => {
    workspaceEventTimer = null;
    pushToControllers({ t: 'event', kind: 'workspaceChanged' });
  }, WORKSPACE_EVENT_DEBOUNCE_MS);
};

// ---------------------------------------------------------------------------
// Controller side: pair with hosts, maintain outbound sessions, proxy requests.

const closeClientSession = (machineId, reason) => {
  const session = clientSessions.get(machineId);
  if (!session) return;
  clientSessions.delete(machineId);
  if (reason) session.lastError = reason;
  session.abortController?.abort(new Error(reason ?? 'Disconnected.'));
  session.channel?.destroy();
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason ?? 'Disconnected.'));
  }
  session.pending.clear();
  publishState();
};

const clientSessionCanContinue = (machineId, session, machine) =>
  !shuttingDown &&
  settings.enabled &&
  Boolean(currentUserId) &&
  (session.route !== 'relay' || relayEnabled()) &&
  clientSessions.get(machineId) === session &&
  remoteMachines.includes(machine) &&
  (!machine.userId || machine.userId === currentUserId);

const cancelledClientSessionError = () =>
  new Error(settings.enabled ? 'The remote session was cancelled.' : 'Remote control is disabled in Settings.');

// ---------------------------------------------------------------------------
// Route selection (controller side).
//
// Direct first, relay second — always, and only those two. Direct is the
// fastest path and keeps the bytes inside your own network; the relay is a
// fallback for when there is no route to the host's address. A machine paired
// over the relay has no address at all, so it goes straight to the relay.
// There is no probing, no racing, and no per-machine preference to get wrong.

const clientRoutes = (machine) => {
  const routes = [];
  if (machine.host && Number.isInteger(machine.port)) routes.push('direct');
  if (relayEnabled()) routes.push('relay');
  return routes;
};

const createControllerTransport = async (route, { host, port, machineId }, signal) => {
  if (route !== 'relay') return createTcpTransport({ host, port });
  // A controller ticket authorizes exactly one socket to exactly one machine.
  // It is not an account credential and is never shown to the peer.
  const issued = await deps.mintRelayTicket({ role: 'controller', machineId, signal });
  if (signal?.aborted) throw cancelledClientSessionError();
  const ticket = typeof issued === 'string' ? issued : issued?.ticket;
  const relayUrl = typeof issued === 'string' ? deps.getRelayUrl?.() : issued?.relayUrl;
  if (!ticket || !relayUrl) throw new Error('Durango Cloud returned invalid relay connection details.');
  return createRelayTransport({ relayUrl, ticket, machineId });
};

/**
 * One outbound handshake. Resolves once encryption is up, with an `onReady`
 * hook for post-handshake messages.
 *
 * The hook exists because SecureChannel drains every complete frame in a
 * transport read synchronously, while this promise resolves on a microtask: if
 * the host writes `confirm` and `welcome` in the same tick and they arrive
 * coalesced, `welcome` reaches the frame loop before the caller can rebind
 * onMessage. Queueing those frames and flushing them into the caller's handler
 * keeps that race from stalling the session until the request timeout.
 */
const openChannel = async ({ createTransport, psk, mode, deviceId, onChannel }) => {
  const transport = await createTransport();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const channel = new SecureChannel(transport, { maxFrame: HANDSHAKE_FRAME_BYTES });
    const handshakeTimer = setTimeout(() => channel.destroy(new Error('Handshake timed out.')), HANDSHAKE_TIMEOUT_MS);
    const eph = createEphemeralKeyPair();
    let stage = 'helloAck';
    let helloRaw = null;
    let transcript = null;
    let keys = null;
    const readyQueue = [];
    let readyHandler = null;
    const onReady = (handler) => {
      readyHandler = handler;
      while (readyQueue.length > 0) handler(readyQueue.shift());
    };

    channel.onClose((error) => {
      clearTimeout(handshakeTimer);
      fail(error ?? new Error('The host closed the connection.'));
    });
    try {
      onChannel?.(channel);
    } catch (error) {
      channel.destroy(error instanceof Error ? error : new Error(String(error)));
    }

    transport.onOpen(() => {
      if (channel.closed) return;
      helloRaw = channel.send({
        t: 'hello',
        v: REMOTE_PROTOCOL_VERSION,
        mode,
        ...(mode === 'session' ? { deviceId } : {}),
        pub: eph.publicDer.toString('base64'),
        nonce: crypto.randomBytes(16).toString('base64'),
      });
    });

    channel.onMessage((message, raw) => {
      if (stage === 'helloAck') {
        if (message?.t !== 'helloAck' || message.v !== REMOTE_PROTOCOL_VERSION || typeof message.pub !== 'string') {
          channel.destroy(new Error('Unexpected handshake response.'));
          return;
        }
        transcript = handshakeTranscript(helloRaw, raw);
        try {
          keys = deriveHandshakeKeys({
            privateKey: eph.privateKey,
            peerPublicDer: Buffer.from(message.pub, 'base64'),
            psk,
            transcript,
            isClient: true,
          });
        } catch {
          channel.destroy(new Error('Handshake failed.'));
          return;
        }
        channel.send({
          t: 'confirm',
          mac: confirmationMac(keys.macKey, 'client', transcript).toString('base64'),
        });
        stage = 'confirm';
        return;
      }
      if (stage === 'confirm') {
        const expected = confirmationMac(keys.macKey, 'server', transcript);
        let received = null;
        try {
          received = Buffer.from(String(message?.mac ?? ''), 'base64');
        } catch {}
        if (!received || !macsEqual(expected, received)) {
          channel.destroy(new Error('The host could not be authenticated.'));
          return;
        }
        channel.enableEncryption(keys);
        channel.setMaxFrame(MAX_FRAME_BYTES);
        clearTimeout(handshakeTimer);
        stage = 'ready';
        if (!settled) {
          settled = true;
          resolve({ channel, transport, onReady });
        }
        return;
      }
      // stage === 'ready': hold anything that arrives before the caller's
      // handler is installed, then hand it over in order.
      if (readyHandler) readyHandler(message);
      else readyQueue.push(message);
    });
  });
};

const outboundPairingCanContinue = (attempt) =>
  outboundPairingAttempts.has(attempt) &&
  !attempt.cancelledReason &&
  !shuttingDown &&
  settings.enabled &&
  Boolean(currentUserId) &&
  (attempt.route !== 'relay' || relayEnabled());

const cancelledOutboundPairingResult = (attempt) => ({
  ok: false,
  error:
    attempt?.cancelledReason ??
    (settings.enabled ? 'The pairing attempt was cancelled.' : 'Remote control is disabled in Settings.'),
});

/**
 * Pair with a host. Addressing is the only thing that differs between the two
 * modes: pass `host` + `port` to reach it directly, or `machineId` to reach it
 * through the relay. Same pairing code, same handshake, same account proof,
 * same single-use semantics either way.
 */
export const pairWithRemoteHost = async ({ host, port, code, machineId } = {}) => {
  if (!identity) {
    return { ok: false, error: stateError ?? 'Remote control is unavailable on this machine.' };
  }
  if (!settings.enabled) {
    return { ok: false, error: 'Remote control is disabled in Settings.' };
  }
  const accountSession = await refreshAccount();
  if (!settings.enabled || shuttingDown) {
    return { ok: false, error: 'Remote control is disabled in Settings.' };
  }
  if (!currentUserId || !accountSession?.token) {
    return { ok: false, error: 'Sign in to your Durango account first.', needsAuth: true };
  }
  try {
    requirePairingPersistence();
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  const targetMachineId = String(machineId ?? '').trim();
  const overRelay = targetMachineId.length > 0;
  const targetHost = overRelay ? '' : String(host ?? '').trim();
  const targetPort = overRelay ? null : Number(port);
  const normalizedCode = normalizePairingCode(code);
  if (overRelay) {
    if (!relayEnabled()) {
      return {
        ok: false,
        error: 'Set this machine’s connection to “Over the internet” to pair by machine ID.',
      };
    }
    if (targetMachineId.length > 128) return { ok: false, error: 'Enter a valid machine ID.' };
    if (targetMachineId === identity.machineId) {
      return { ok: false, error: 'A machine cannot pair with itself.' };
    }
  } else {
    if (!targetHost) return { ok: false, error: 'Enter the host machine’s address.' };
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return { ok: false, error: 'Enter a valid port.' };
    }
  }
  if (normalizedCode.length < 12) return { ok: false, error: 'Enter the full pairing code.' };

  // A retry supersedes any older controller-side attempt. Abort its transport
  // and Cloud proof request before registering the replacement owner.
  cancelOutboundPairingAttempts('A newer pairing attempt started.');
  const attempt = {
    route: overRelay ? 'relay' : 'direct',
    channel: null,
    cancelledReason: null,
    abortController: new AbortController(),
  };
  outboundPairingAttempts.add(attempt);
  try {
  let connection;
  try {
    connection = await openChannel({
      createTransport: () =>
        createControllerTransport(overRelay ? 'relay' : 'direct', {
          host: targetHost,
          port: targetPort,
          machineId: targetMachineId,
        }, attempt.abortController.signal),
      psk: pairingCodeToPsk(normalizedCode),
      mode: 'pair',
      onChannel: (channel) => {
        attempt.channel = channel;
        if (!outboundPairingCanContinue(attempt)) {
          throw new Error(cancelledOutboundPairingResult(attempt).error);
        }
      },
    });
  } catch (error) {
    if (!outboundPairingCanContinue(attempt)) return cancelledOutboundPairingResult(attempt);
    return {
      ok: false,
      error: overRelay
        ? `Could not pair: ${error?.message ?? error}. Check the machine ID and code, and that the other machine is online over the internet.`
        : `Could not pair: ${error?.message ?? error}. Check the address, port, and code.`,
      };
  }

  if (!outboundPairingCanContinue(attempt)) {
    connection.channel.destroy();
    return cancelledOutboundPairingResult(attempt);
  }

  const { channel, onReady } = connection;
  const result = await new Promise((resolve) => {
    let requestSent = false;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      channel.destroy();
      resolve({ ok: false, error: 'The host did not answer the pairing request.' });
    }, REQUEST_TIMEOUT_MS);
    channel.onClose(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: 'The host closed the connection during pairing.' });
    });
    onReady((message) => {
      if (message?.t === 'pairChallenge' && !requestSent) {
        const challenge = String(message?.challenge ?? '');
        const hostMachineId = String(message?.host?.id ?? '');
        // Over the relay the user names the machine, so hold the peer to it.
        // The handshake MAC already makes misrouting unexploitable; this makes
        // it visible instead of silently pairing with the wrong machine.
        if (
          !challenge ||
          challenge.length > 256 ||
          !hostMachineId ||
          hostMachineId === identity.machineId ||
          (overRelay && hostMachineId !== targetMachineId)
        ) {
          settled = true;
          clearTimeout(timer);
          channel.destroy();
          resolve({ ok: false, error: 'The host sent an invalid pairing challenge.' });
          return;
        }
        requestSent = true;
        void deps
          .createRemotePairingProof({
            token: accountSession.token,
            challenge,
            machineId: hostMachineId,
            signal: attempt.abortController.signal,
          })
          .then((accountProof) => {
            if (settled) return;
            if (!outboundPairingCanContinue(attempt)) {
              settled = true;
              clearTimeout(timer);
              channel.destroy();
              resolve(cancelledOutboundPairingResult(attempt));
              return;
            }
            channel.send({
              t: 'pair',
              reqId: crypto.randomUUID(),
              device: { id: identity.machineId, name: identity.machineName },
              accountProof,
            });
          })
          .catch((error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            channel.destroy();
            resolve({
              ok: false,
              error: error?.message ?? 'Could not authenticate the controlling Durango account.',
            });
          });
        return;
      }
      if (message?.t !== 'res' || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(message);
      channel.close();
    });
  });

  if (!outboundPairingCanContinue(attempt)) return cancelledOutboundPairingResult(attempt);
  if (!result?.ok) {
    return { ok: false, error: result?.error ?? 'Pairing failed.' };
  }
  const refreshedSession = await refreshAccount();
  if (!outboundPairingCanContinue(attempt)) return cancelledOutboundPairingResult(attempt);
  if (!currentUserId || !refreshedSession?.token) {
    return { ok: false, error: 'The controlling machine signed out during pairing.', needsAuth: true };
  }
  if (typeof result.secret !== 'string' || typeof result.host?.id !== 'string') {
    return { ok: false, error: 'The host sent an invalid pairing response.' };
  }
  if (result.userId !== currentUserId) {
    return { ok: false, error: 'The host is signed in to a different Durango account.' };
  }
  if (overRelay && result.host.id !== targetMachineId) {
    return { ok: false, error: 'The relay connected a different machine than the one requested.' };
  }
  let outcome;
  try {
    outcome = await mutatePersistedState({
      canStart: () => outboundPairingCanContinue(attempt),
      canCommit: () => outboundPairingCanContinue(attempt),
      mutate: () => {
        const nextMachines = remoteMachines.filter((machine) => machine.id !== result.host.id);
        nextMachines.push({
          id: result.host.id,
          name: String(result.host.name ?? targetHost ?? result.host.id).slice(0, 120),
          host: overRelay ? null : targetHost,
          port: overRelay ? null : targetPort,
          relay: overRelay,
          userId: result.userId,
          secret: result.secret,
          pairedAt: new Date().toISOString(),
        });
        remoteMachines = nextMachines;
      },
    });
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  if (!outcome.committed) {
    publishState();
    return cancelledOutboundPairingResult(attempt);
  }
  publishState();
  return { ok: true, machine: { id: result.host.id, name: result.host.name } };
  } finally {
    attempt.abortController.abort(new Error('Pairing attempt finished.'));
    outboundPairingAttempts.delete(attempt);
  }
};

export const removeRemoteMachine = async ({ machineId } = {}) => {
  if (shuttingDown) return { ok: false, error: 'Remote control is shutting down.' };
  try {
    requirePairingPersistence();
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  const id = String(machineId ?? '');
  let outcome;
  try {
    outcome = await mutatePersistedState({
      mutate: () => {
        const nextMachines = remoteMachines.filter((machine) => machine.id !== id);
        if (nextMachines.length === remoteMachines.length) {
          return { changed: false, value: { found: false } };
        }
        remoteMachines = nextMachines;
        return { value: { found: true } };
      },
    });
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  if (!outcome.value?.found) return { ok: false, error: 'Machine not found.' };
  closeClientSession(id, null);
  publishState();
  return { ok: true };
};

const ensureClientSession = async (machineId) => {
  if (!identity) throw new Error(stateError ?? 'Remote control is unavailable on this machine.');
  if (!settings.enabled) throw new Error('Remote control is disabled in Settings.');
  await refreshAccount();
  if (!currentUserId) throw new Error('Sign in to your Durango account first.');
  const machine = remoteMachines.find((candidate) => candidate.id === machineId);
  if (!machine) throw new Error('This machine is not paired.');
  if (machine.userId && machine.userId !== currentUserId) {
    throw new Error('This machine was paired under a different Durango account.');
  }

  const existing = clientSessions.get(machineId);
  if (existing?.ready) return existing;
  if (existing?.connectPromise) return existing.connectPromise;

  const session = {
    machineId,
    channel: null,
    ready: false,
    connecting: true,
    lastError: null,
    pending: new Map(), // reqId -> { resolve, reject, timer }
    connectPromise: null,
    route: null,
    abortController: new AbortController(),
  };
  clientSessions.set(machineId, session);
  publishState();

  session.connectPromise = (async () => {
    const routes = clientRoutes(machine);
    let connection = null;
    let lastError = new Error('No route to this machine. Add its address, or switch to internet mode.');
    for (const route of routes) {
      session.route = route;
      if (!clientSessionCanContinue(machineId, session, machine)) {
        lastError = cancelledClientSessionError();
        break;
      }
      try {
        connection = await openChannel({
          createTransport: () =>
            createControllerTransport(route, {
              host: machine.host,
              port: machine.port,
              machineId: machine.id,
            }, session.abortController.signal),
          psk: Buffer.from(machine.secret, 'base64'),
          mode: 'session',
          deviceId: identity.machineId,
          // Attach before the handshake resolves so reconciliation can destroy a
          // parked socket immediately when Remote Control is switched off.
          onChannel: (channel) => {
            if (!clientSessionCanContinue(machineId, session, machine)) throw cancelledClientSessionError();
            session.channel = channel;
          },
        });
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // A cancelled session is not a routing failure — do not try the next
        // route after remote control has been switched off underneath us.
        if (!clientSessionCanContinue(machineId, session, machine)) break;
      }
    }
    if (!connection) {
      session.connecting = false;
      session.connectPromise = null;
      session.lastError = lastError?.message ?? String(lastError);
      publishState();
      throw new Error(`Could not reach ${machine.name}: ${session.lastError}`);
    }

    const { channel, onReady } = connection;
    // Re-check after the awaited handshake as defense in depth: the master
    // switch, account, or pairing ownership may have changed as it completed.
    if (!clientSessionCanContinue(machineId, session, machine)) {
      channel.destroy();
      throw cancelledClientSessionError();
    }
    session.channel = channel;

    // Frames that arrive before the post-welcome router is installed are
    // queued by openChannel, so nothing is lost between these two handlers.
    // Frames coalesced into the same read AFTER welcome (the host can push an
    // event immediately) are held here and replayed once the router exists.
    let routeMessage = null;
    const beforeRouter = [];
    const welcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS);
      onReady((message) => {
        if (routeMessage) {
          routeMessage(message);
          return;
        }
        if (message?.t !== 'welcome') {
          beforeRouter.push(message);
          return;
        }
        clearTimeout(timer);
        resolve(message);
      });
      channel.onClose(() => {
        clearTimeout(timer);
        resolve(null);
      });
    });

    if (!clientSessionCanContinue(machineId, session, machine)) {
      channel.destroy();
      throw cancelledClientSessionError();
    }

    if (
      !welcome ||
      welcome.machine?.id !== machine.id ||
      typeof welcome.userId !== 'string' ||
      welcome.userId !== currentUserId
    ) {
      channel.destroy();
      session.connecting = false;
      session.connectPromise = null;
      session.lastError = !welcome
        ? 'The host did not complete the session.'
        : 'The host’s identity or account did not match the pairing.';
      publishState();
      throw new Error(session.lastError);
    }

    // Session is live: route responses and pushed events.
    routeMessage = (message) => {
      if (message?.t === 'claimed' && typeof message.reqId === 'string') {
        const pending = session.pending.get(message.reqId);
        const completionTimeoutMs = Math.min(
          REQUEST_TIMEOUT_MS,
          Math.max(1, Number(message.completionTimeoutMs))
        );
        if (pending?.extendOnClaim && !pending.claimed && Number.isFinite(completionTimeoutMs)) {
          pending.claimed = true;
          clearTimeout(pending.timer);
          pending.timer = setTimeout(
            pending.onTimeout,
            completionTimeoutMs + (
              Number.isFinite(deps?.clientResponseGraceMs)
                ? Math.max(0, deps.clientResponseGraceMs)
                : CLIENT_RESPONSE_GRACE_MS
            )
          );
        }
        return;
      }
      if (message?.t === 'res' && typeof message.reqId === 'string') {
        const pending = session.pending.get(message.reqId);
        if (pending) {
          session.pending.delete(message.reqId);
          clearTimeout(pending.timer);
          pending.resolve(message);
        }
        return;
      }
      if (message?.t === 'event') {
        deps.broadcast('remote:event', {
          machineId,
          kind: message.kind,
          payload: message.payload ?? null,
        });
      }
    };
    while (beforeRouter.length > 0) routeMessage(beforeRouter.shift());
    channel.onClose(() => {
      if (clientSessions.get(machineId) === session) {
        clientSessions.delete(machineId);
        session.ready = false;
        session.connecting = false;
        session.connectPromise = null;
        session.lastError = 'Disconnected from the host.';
        for (const pending of session.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Disconnected from the host.'));
        }
        session.pending.clear();
        publishState();
      }
    });
    // `onClose` replays a close that landed during the handler handoff above.
    // Do not promote the now-unowned local object after that synchronous replay.
    if (channel.closed || clientSessions.get(machineId) !== session) {
      throw new Error(session.lastError ?? 'Disconnected from the host.');
    }

    // Refresh the display name we hold for the host.
    if (typeof welcome.machine?.name === 'string' && welcome.machine.name && welcome.machine.name !== machine.name) {
      const previousName = machine.name;
      machine.name = welcome.machine.name.slice(0, 120);
      void savePersistedState().catch(() => {
        machine.name = previousName;
        publishState();
      });
    }

    session.ready = true;
    session.connecting = false;
    session.connectPromise = null;
    publishState();
    return session;
  })();

  return session.connectPromise;
};

const clientRequest = async (
  machineId,
  message,
  timeoutMs = REQUEST_TIMEOUT_MS,
  { extendOnClaim = false } = {}
) => {
  const session = await ensureClientSession(machineId);
  // `await ensureClientSession` yields even for an already-ready session. The
  // settings/account reconciliation may close it during that gap, so dispatch
  // must verify live ownership instead of sending on the stale object.
  if (
    !settings.enabled ||
    (session.route === 'relay' && !relayEnabled()) ||
    clientSessions.get(machineId) !== session ||
    !session.ready ||
    !session.channel
  ) {
    throw new Error(settings.enabled ? 'The remote session was cancelled.' : 'Remote control is disabled in Settings.');
  }
  return new Promise((resolve, reject) => {
    const reqId = crypto.randomUUID();
    let pending = null;
    const onTimeout = () => {
      if (session.pending.get(reqId) !== pending) return;
      session.pending.delete(reqId);
      reject(new Error('The host did not respond in time.'));
    };
    const timer = setTimeout(onTimeout, timeoutMs);
    pending = { resolve, reject, timer, onTimeout, extendOnClaim, claimed: false };
    session.pending.set(reqId, pending);
    session.channel.send({ ...message, reqId });
  });
};

const clientErrorResult = (error) => ({ ok: false, error: error?.message ?? String(error) });

export const connectRemoteMachine = async ({ machineId } = {}) => {
  try {
    await ensureClientSession(String(machineId ?? ''));
    return { ok: true };
  } catch (error) {
    return clientErrorResult(error);
  }
};

export const disconnectRemoteMachine = ({ machineId } = {}) => {
  closeClientSession(String(machineId ?? ''), null);
  return { ok: true };
};

export const fetchRemoteSnapshot = async ({ machineId } = {}) => {
  try {
    const response = await clientRequest(String(machineId ?? ''), { t: 'snapshot' });
    return response.ok
      ? { ok: true, snapshot: response.snapshot }
      : { ok: false, error: response.error ?? 'Snapshot failed.' };
  } catch (error) {
    return clientErrorResult(error);
  }
};

export const fetchRemoteThread = async ({ machineId, threadId } = {}) => {
  try {
    const targetMachineId = String(machineId ?? '');
    const targetThreadId = String(threadId ?? '');
    const chunks = [];
    let expectedOffset;
    let expectedVersion;
    let expectedBytes;
    for (;;) {
      const response = await clientRequest(targetMachineId, {
        t: 'thread',
        threadId: targetThreadId,
        threadChunking: true,
        ...(expectedOffset === undefined ? {} : { threadOffset: expectedOffset }),
        ...(expectedVersion === undefined ? {} : { threadVersion: expectedVersion }),
      });
      if (!response.ok) return { ok: false, error: response.error ?? 'Thread fetch failed.' };
      // Ordinary and older hosts return the complete thread in one response.
      if (response.thread !== undefined && expectedOffset === undefined) {
        return { ok: true, thread: response.thread };
      }
      if (
        typeof response.threadChunk !== 'string' ||
        !Number.isSafeInteger(response.threadOffset) ||
        response.threadOffset !== (expectedOffset ?? 0) ||
        typeof response.threadVersion !== 'string' ||
        !Number.isSafeInteger(response.threadBytes) ||
        response.threadBytes <= 0 ||
        response.threadBytes > MAX_THREAD_TRANSFER_BYTES ||
        (expectedVersion !== undefined && response.threadVersion !== expectedVersion) ||
        (expectedBytes !== undefined && response.threadBytes !== expectedBytes)
      ) {
        throw new Error('The host sent an invalid thread chunk.');
      }
      const chunk = Buffer.from(response.threadChunk, 'base64');
      if (chunk.length === 0 || chunk.length > THREAD_CHUNK_BYTES) {
        throw new Error('The host sent an invalid thread chunk.');
      }
      chunks.push(chunk);
      expectedVersion = response.threadVersion;
      expectedBytes = response.threadBytes;
      const receivedBytes = response.threadOffset + chunk.length;
      if (response.nextThreadOffset === null) {
        if (receivedBytes !== expectedBytes) throw new Error('The host sent an incomplete thread.');
        let thread;
        try {
          thread = JSON.parse(Buffer.concat(chunks, expectedBytes).toString('utf8'));
        } catch {
          throw new Error('The host sent a malformed thread.');
        }
        return { ok: true, thread };
      }
      if (
        !Number.isSafeInteger(response.nextThreadOffset) ||
        response.nextThreadOffset !== receivedBytes ||
        response.nextThreadOffset >= expectedBytes
      ) {
        throw new Error('The host sent an invalid thread chunk.');
      }
      expectedOffset = response.nextThreadOffset;
    }
  } catch (error) {
    return clientErrorResult(error);
  }
};

export const runRemoteTurn = async ({
  machineId,
  threadId,
  projectId,
  epicId,
  prompt,
  modelId,
  accessMode,
  reasoningEffort,
  codexServiceTier,
  claudeContextWindow,
} = {}) => {
  try {
    const requestedAccessMode = sanitizeAccessMode(accessMode);
    const requestedReasoningEffort = sanitizeReasoningEffort(reasoningEffort);
    const requestedCodexServiceTier = sanitizeCodexServiceTier(codexServiceTier);
    const requestedClaudeContextWindow = sanitizeClaudeContextWindow(claudeContextWindow);
    const response = await clientRequest(
      String(machineId ?? ''),
      {
        t: 'runTurn',
        ...(threadId ? { threadId: String(threadId) } : {}),
        ...(projectId ? { projectId: String(projectId) } : {}),
        ...(epicId ? { epicId: String(epicId) } : {}),
        ...(modelId ? { modelId: String(modelId) } : {}),
        ...(requestedAccessMode ? { accessMode: requestedAccessMode } : {}),
        ...(requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : {}),
        ...(requestedCodexServiceTier ? { codexServiceTier: requestedCodexServiceTier } : {}),
        ...(requestedClaudeContextWindow
          ? { claudeContextWindow: requestedClaudeContextWindow }
          : {}),
        prompt: String(prompt ?? ''),
      },
      (Number.isFinite(deps?.runTurnTimeoutMs) ? Math.max(1, deps.runTurnTimeoutMs) : RUN_TURN_TIMEOUT_MS) +
        (Number.isFinite(deps?.clientResponseGraceMs)
          ? Math.max(0, deps.clientResponseGraceMs)
          : CLIENT_RESPONSE_GRACE_MS),
      { extendOnClaim: true }
    );
    return {
      ok: response.ok === true,
      threadId: typeof response.threadId === 'string' ? response.threadId : undefined,
      error: response.ok ? undefined : (response.error ?? 'The remote turn could not start.'),
    };
  } catch (error) {
    return clientErrorResult(error);
  }
};

export const createRemoteEpic = async ({ machineId, name, description, projectIds } = {}) => {
  try {
    const response = await clientRequest(
      String(machineId ?? ''),
      {
        t: 'createEpic',
        name: String(name ?? ''),
        ...(description ? { description: String(description) } : {}),
        ...(Array.isArray(projectIds) ? { projectIds: projectIds.map(String) } : {}),
      },
      (Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS) +
        (Number.isFinite(deps?.clientResponseGraceMs)
          ? Math.max(0, deps.clientResponseGraceMs)
          : CLIENT_RESPONSE_GRACE_MS),
      { extendOnClaim: true }
    );
    return {
      ok: response.ok === true,
      epicId: typeof response.epicId === 'string' ? response.epicId : undefined,
      error: response.ok ? undefined : (response.error ?? 'The epic could not be created.'),
    };
  } catch (error) {
    return clientErrorResult(error);
  }
};

export const stopRemoteTurn = async ({ machineId, threadId } = {}) => {
  try {
    const response = await clientRequest(
      String(machineId ?? ''),
      {
        t: 'stopTurn',
        threadId: String(threadId ?? ''),
      },
      (Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS) +
        (Number.isFinite(deps?.clientResponseGraceMs)
          ? Math.max(0, deps.clientResponseGraceMs)
          : CLIENT_RESPONSE_GRACE_MS),
      { extendOnClaim: true }
    );
    return response.ok ? { ok: true } : { ok: false, error: response.error ?? 'Stop failed.' };
  } catch (error) {
    return clientErrorResult(error);
  }
};
