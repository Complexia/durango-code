import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
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
  PAIRING_CODE_LENGTH,
  pairingCodeToPsk,
} from './remote-crypto.js';
import { sanitizeAttachmentName } from './media.js';
import { EXEC_MAX_TIMEOUT_MS, runExecCommand } from './remote-exec.js';
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
/** A Durango Source clone on the host (checkoutSource). */
const SOURCE_CHECKOUT_TIMEOUT_MS = 65 * 60_000;
const CLIENT_RESPONSE_GRACE_MS = 10_000;
/** Hidden agent context a controller may send with a turn (runTurn `context`). */
const MAX_TURN_CONTEXT_CHARS = 400_000;
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
// Attachments travel as chunks too (controller → host for a turn's files, host
// → controller to show the host's attachments in the controller's mirror).
// 3 MiB of raw bytes is 4 MiB of base64, well under MAX_FRAME_BYTES.
const ATTACHMENT_CHUNK_BYTES = 3 * 1024 * 1024;
// What a host without resumable uploads (`uploads2`) accepts, and the largest
// host attachment this machine copies for its mirror of a thread there.
const LEGACY_MAX_REMOTE_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_MIRRORED_ATTACHMENT_BYTES = 100 * 1024 * 1024;
// Resumable uploads (uploadOpen / uploadChunk / uploadStatus): fixed-size
// chunks at chunk-aligned offsets, several in flight at once and written where
// they belong, so they may land in any order and a dropped connection resumes
// where the host's copy stops. The size bound is a sanity check; the real
// limit is the host's free disk space.
const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_REMOTE_ATTACHMENT_BYTES = 64 * 1024 * 1024 * 1024;
const UPLOAD_DISK_HEADROOM_BYTES = 512 * 1024 * 1024;
// Chunks in flight per host. Each is ~2.7 MiB of base64 on the wire; four stay
// well under the transports' pending-write ceiling (MAX_PENDING_WRITE_BYTES).
const UPLOAD_WINDOW_CHUNKS = 4;
// A chunk queued behind the others on a slow uplink waits for them too.
const UPLOAD_CHUNK_TIMEOUT_MS = 120_000;
const UPLOAD_RESUME_ATTEMPTS = 6;
// A resumable upload outlives the session it started on: a controller that
// reconnects picks it up. Unfinished ones go after this long without a chunk,
// finished ones no turn has used (yet) after the second.
const UNFINISHED_UPLOAD_TTL_MS = 30 * 60 * 1000;
const UNCLAIMED_UPLOAD_TTL_MS = 60 * 60 * 1000;
// What this host supports beyond the base protocol, announced in `welcome`.
const HOST_FEATURES = ['uploads2', 'lan'];
// The controller's connection that carries uploads, separate from the one
// that carries the thread, closes after this long unused.
const TRANSFER_SESSION_IDLE_MS = 60_000;
// Learned local-network route to a machine paired over the internet: tried
// before the relay, briefly, and not again for a while once it failed.
const LAN_CONNECT_TIMEOUT_MS = 1500;
const LAN_RETRY_AFTER_MS = 2 * 60 * 1000;
const MAX_LAN_ADDRESSES = 6;
// Uploads one session may hold open (unfinished) at once.
const MAX_OPEN_UPLOADS = 16;
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
// Outbound sessions by key: the machine id for the session that carries a
// machine's threads, transferSessionKey(machineId) for the one that carries
// its uploads.
const clientSessions = new Map();
const transferSessionKey = (machineId) => `${machineId}\u0000transfer`;
// Resumable uploads this host holds, by the controller device that sent them
// (deviceId -> uploadId -> upload): any session of that device may continue
// or use one.
const deviceUploads = new Map();
// Learned local-network routes that just failed: machineId -> when.
const lanFailures = new Map();
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
        // Where the host said it listens on its local network (sanitized
        // again: the file is ours, but its contents decide where we dial).
        lan: sanitizeLanRoute(entry?.lan),
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
      ...(machine.lan ? { lan: machine.lan } : {}),
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

// Private (RFC 1918) and carrier-grade NAT (Tailscale and similar VPNs)
// IPv4 addresses: the only kind a host announces for its local route, and the
// only kind a controller dials from one.
const isPrivateIPv4 = (value) => {
  if (!net.isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

// Tests run both machines on one: they may announce loopback.
const isLanAddress = (value) =>
  isPrivateIPv4(value) || (deps?.allowLoopbackLan === true && net.isIPv4(value) && value.startsWith('127.'));

// Container and VM bridges: addresses that exist on many machines at once
// (docker0 is 172.17.0.1 everywhere), so dialing one could reach the wrong
// machine — or this one.
const VIRTUAL_INTERFACE_PATTERN = /^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|podman|bridge\d)/i;

/** Where this host can be reached on its own networks, for `welcome`. */
const lanAddresses = () => {
  if (typeof deps?.lanAddresses === 'function') {
    return (deps.lanAddresses() ?? []).filter(isLanAddress).slice(0, MAX_LAN_ADDRESSES);
  }
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_INTERFACE_PATTERN.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)].slice(0, MAX_LAN_ADDRESSES);
};

const sanitizeLanRoute = (value) => {
  if (!value || typeof value !== 'object') return null;
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const addresses = [
    ...new Set((Array.isArray(value.addresses) ? value.addresses : []).map(String).filter(isLanAddress)),
  ].slice(0, MAX_LAN_ADDRESSES);
  return addresses.length > 0 ? { addresses, port } : null;
};

// ---------------------------------------------------------------------------
// Host firewall (Linux, ufw): a host whose firewall drops its port is only
// reachable through the relay, which is far slower for large files. Settings
// says so and gives the command that opens it. Read from ufw's own rule files
// (world-readable on the distributions that ship it); anything unreadable or
// unusual reports nothing rather than a guess.

let firewallNotice = null; // { tool, port, command } | null
let firewallCheckedPort = null;

const portInUfwSpec = (spec, port) => {
  if (spec === 'any') return true;
  return spec.split(',').some((part) => {
    const [from, to] = part.split(':').map(Number);
    if (!Number.isInteger(from)) return false;
    return Number.isInteger(to) ? port >= from && port <= to : port === from;
  });
};

export const ufwBlocksPort = ({ conf, rules, defaults }, port) => {
  if (!/^\s*ENABLED\s*=\s*yes\s*$/im.test(String(conf ?? ''))) return false;
  const policy = /^\s*DEFAULT_INPUT_POLICY\s*=\s*"?(\w+)"?/im.exec(String(defaults ?? ''))?.[1]?.toUpperCase();
  if (policy === 'ACCEPT') return false;
  // `### tuple ### allow tcp 47615 0.0.0.0/0 any 192.168.1.0/24 in`:
  // action, protocol, destination port, destination, source port, source, direction.
  for (const line of String(rules ?? '').split('\n')) {
    const match = /^###\s+tuple\s+###\s+(\S+)\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+\S+(?:\s+(\S+))?/.exec(line.trim());
    if (!match) continue;
    const [, action, protocol, destinationPort, direction = 'in'] = match;
    if (!action.startsWith('allow') || direction !== 'in') continue;
    if (protocol !== 'tcp' && protocol !== 'any') continue;
    if (portInUfwSpec(destinationPort, port)) return false;
  }
  return true;
};

const checkHostFirewall = async (port) => {
  if ((deps?.platform ?? process.platform) !== 'linux') return;
  firewallCheckedPort = port;
  const read = (file) =>
    (typeof deps?.readFirewallFile === 'function' ? deps.readFirewallFile(file) : fs.readFile(file, 'utf8')).catch(
      () => null
    );
  try {
    const [conf, rules, defaults] = await Promise.all([
      read('/etc/ufw/ufw.conf'),
      read('/etc/ufw/user.rules'),
      read('/etc/default/ufw'),
    ]);
    if (firewallCheckedPort !== port) return;
    const blocked = conf !== null && rules !== null && ufwBlocksPort({ conf, rules, defaults }, port);
    const next = blocked ? { tool: 'ufw', port, command: `sudo ufw allow ${port}/tcp` } : null;
    if (JSON.stringify(next) !== JSON.stringify(firewallNotice)) {
      firewallNotice = next;
      publishState();
    }
  } catch {}
};

const clientStatus = (machineId) => {
  const session = clientSessions.get(machineId);
  if (!session) return { status: 'offline', error: null };
  if (session.ready) return { status: 'connected', route: session.route, error: null };
  if (session.connecting) return { status: 'connecting', error: null };
  return { status: session.lastError ? 'error' : 'offline', error: session.lastError };
};

export const getRemoteControlState = () => {
  if (!stateLoaded || !identity || pairingPersistenceUnavailable()) {
    // `authenticated` and `starting` let the settings panel tell "sign in
    // first" apart from "still starting" and "cannot run here"; without them
    // an engine that failed to start read as a signed-out account.
    return {
      available: false,
      starting: !stateLoaded,
      authenticated: Boolean(currentUserId),
      error:
        stateError ??
        pairingPersistenceUnavailable() ??
        (stateLoaded ? 'Remote control could not start on this machine.' : null),
    };
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
      firewall: listening ? firewallNotice : null,
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
  try {
    await loadPersistedState();
    await applyPendingUserIdMigrations();
    // The renderer may have read a `starting` state already; reconcile only
    // publishes when the engine is usable, so report the loaded state here.
    publishState();
  } catch (error) {
    // Leave a reason on the state instead of an engine that never finished
    // loading, which the settings panel cannot explain.
    console.error('remote-control: start error', error);
    identity = null;
    stateError = `Remote control could not start: ${error?.message || String(error)}`;
    stateLoaded = true;
    publishState();
    throw error;
  }
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
  removeUnusedUploadFilesSync();
  cancelHostUploadTransfers('Shutting down.');
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
      void checkHostFirewall(port);
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
  discardResumableUploads();
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
  discardResumableUploads(id);
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
    // Chunked thread pulls in progress, one per thread (threadId → transfer).
    threadTransfers: new Map(),
    // Attachments the controller uploaded in this session: uploadId → file.
    uploads: new Map(),
    // Shell commands running for this controller (exec): execId → AbortController.
    execs: new Map(),
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
    discardUnfinishedUploads(session);
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
        // A pairing attempt while this machine shows no code can never
        // succeed and is what a controller pairing by code alone sends to
        // each of the account's machines in turn (pairByCode): don't let it
        // count toward the rate limit that relay connections share, or a few
        // mistyped codes would lock this machine out of the relay. Pairing
        // attempts against a live code, and session handshakes, still count.
        const pairWithoutCode = session.mode === 'pair' && !session.challengedPairingPsk;
        if (!pairWithoutCode) registerHandshakeFailure(ip);
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
          features: HOST_FEATURES,
          // Where this machine listens on its own networks: a controller that
          // reached it through the relay tries these first next time.
          lan: listening && listeningPort ? { port: listeningPort, addresses: lanAddresses() } : null,
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
export const claimRemoteCommand = ({ commandId, threadId } = {}) => {
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
    pending.onClaim?.(completionTimeoutMs, typeof threadId === 'string' ? threadId : null);
  } catch {}
  return { ok: true };
};

export const resolveRemoteCommand = (payload) => {
  const pending = pendingRendererCommands.get(payload?.commandId);
  if (!pending) return { ok: false };
  settlePendingRendererCommand(payload.commandId, pending, {
    ok: payload?.ok === true,
    threadId: typeof payload?.threadId === 'string' ? payload.threadId : undefined,
    projectId: typeof payload?.projectId === 'string' ? payload.projectId : undefined,
    error: typeof payload?.error === 'string' ? payload.error : undefined,
  });
  return { ok: true };
};

const optionalString = (value) => (typeof value === 'string' && value ? value : null);

// Where a thread sits in the sidebar (settled, snoozed, pinned), as paired
// machines send it to each other: each key present is a time it was set, or
// null for cleared; absent keys stay as they are. Null when nothing valid.
export const THREAD_SIDEBAR_STATE_KEYS = ['settledAt', 'snoozedAt', 'pinnedAt'];
export const sanitizeThreadSidebarState = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = {};
  for (const key of THREAD_SIDEBAR_STATE_KEYS) {
    if (!(key in value)) continue;
    const time = value[key];
    if (time === null) state[key] = null;
    else if (typeof time === 'string' && time.length <= 64 && Number.isFinite(Date.parse(time))) state[key] = time;
    else return null;
  }
  return Object.keys(state).length > 0 ? state : null;
};

const buildSnapshot = async () => {
  const state = (await deps.readStoreState()) ?? {};
  const threadIndex = deps.readThreadsIndex
    ? await deps.readThreadsIndex()
    : { entries: (await deps.readThreadsFile())?.threads ?? [] };
  const entries = Array.isArray(threadIndex?.entries) ? threadIndex.entries : [];
  // A thread whose subagent waits on the user waits on the user: roll
  // questions and actions up to the top-level thread a controller lists.
  const rootOf = (() => {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return (id) => {
      let current = id;
      const seen = new Set();
      for (;;) {
        const parentId = parentIdOf(byId.get(current));
        if (!parentId || seen.has(parentId) || !byId.has(parentId)) return current;
        seen.add(current);
        current = parentId;
      }
    };
  })();
  const waitingRoots = new Set();
  const actionsByRoot = new Map();
  for (const entry of entries) {
    const shell = entry?.shell ?? entry;
    if (!shell?.id || shell.remote) continue;
    const root = rootOf(shell.id);
    if (deps.hasPendingQuestions?.(shell.id) === true) waitingRoots.add(root);
    if (Array.isArray(shell.userActions) && shell.userActions.length > 0) {
      if (!actionsByRoot.has(root)) actionsByRoot.set(root, []);
      actionsByRoot.get(root).push(...shell.userActions.map((action) => ({ ...action, ownerThreadId: shell.id })));
    }
  }
  const projects = [
    ...(state.noProject ? [state.noProject] : []),
    ...(Array.isArray(state.projects) ? state.projects : []),
  ];
  // Durango Source repository ids let a controller match these projects to
  // its own checkouts of the same repositories.
  const repoIds = deps.projectRepoIds ? await deps.projectRepoIds(projects).catch(() => null) : null;
  return {
    machine: { id: identity.machineId, name: identity.machineName },
    capturedAt: new Date().toISOString(),
    // Remote clients group threads by these entries. Include the scratch
    // workspace on the wire without adding it to the host's saved projects.
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      repoId: repoIds?.get?.(project.path) ?? null,
    })),
    threads: entries
      .map((entry) => ({ shell: entry?.shell ?? entry, summary: entry?.summary ?? null, entry }))
      // A thread that itself runs on another machine is that machine's to
      // list: mirroring a mirror would loop between two paired machines.
      .filter(({ shell }) => shell && typeof shell.id === 'string' && !shell.remote)
      .map(({ shell, summary, entry }) => {
        const base = {
          id: shell.id,
          projectId: shell.projectId,
          parentThreadId: shell.parentThreadId ?? null,
          subagent: Boolean(shell.subagent),
          // Its type (Explore, general-purpose, …), for a controller's subagent switcher.
          ...(typeof shell.subagent?.kind === 'string' && shell.subagent.kind
            ? { subagentKind: shell.subagent.kind.slice(0, 200) }
            : {}),
          // Started by an agent on a paired machine: that machine lists it
          // under the thread there instead of in its sidebar.
          ...(typeof shell.spawnedBy?.machineId === 'string' && typeof shell.spawnedBy?.threadId === 'string'
            ? { spawnedBy: { machineId: shell.spawnedBy.machineId, threadId: shell.spawnedBy.threadId } }
            : {}),
          title: shell.title,
          status: shell.status,
          modelId: shell.modelId,
          createdAt: shell.createdAt,
          updatedAt: entry.updatedAt ?? summary?.lastMessage?.ts ?? shell.messages?.at?.(-1)?.ts ?? shell.createdAt,
          messageCount: Number.isSafeInteger(entry.messageCount)
            ? entry.messageCount
            : Number.isSafeInteger(summary?.messageCount)
              ? summary.messageCount
              : Array.isArray(shell.messages) ? shell.messages.length : 0,
        };
        // Subagent threads ride along for clients that show them under their
        // parent (app.durango.sh, a desktop's subagent switcher); the details
        // below are for listing threads in a controller's sidebar, which
        // never lists them.
        if (base.parentThreadId || base.subagent) return base;
        const userActions = actionsByRoot.get(shell.id) ?? [];
        return {
          ...base,
          ...(summary && typeof summary === 'object' ? { summary } : {}),
          // What the thread (or a subagent of it) waits on the user for, so a
          // controller's sidebar can say "Needs you" without opening it.
          ...(userActions.length > 0 ? { userActions } : {}),
          ...(waitingRoots.has(shell.id) ? { waitingOnQuestion: true } : {}),
          // Where the thread sits in the sidebar there. A controller follows
          // changes to these (settle, snooze, pin) and sends its own back
          // (`threadState`), so both machines file the thread the same way.
          settledAt: optionalString(shell.settledAt),
          snoozedAt: optionalString(shell.snoozedAt),
          pinnedAt: optionalString(shell.pinnedAt),
          hiddenFromRecent: shell.hiddenFromRecent === true,
          workspaceName: optionalString(shell.durangoWorkspace?.name),
          ...(optionalString(shell.startedByBot) ? { startedByBot: optionalString(shell.startedByBot) } : {}),
          ...(optionalString(shell.startedByBotId) ? { startedByBotId: optionalString(shell.startedByBotId) } : {}),
          // What the controller's prompt box shows for the thread.
          settings: Object.fromEntries(
            [
              'accessMode',
              'codexReasoningEffort',
              'codexServiceTier',
              'claudeReasoningEffort',
              'claudeContextWindow',
              'grokReasoningEffort',
              'museReasoningEffort',
              'antigravityReasoningEffort',
              'openCodeReasoningEffort',
            ]
              .filter((key) => typeof shell[key] === 'string')
              .map((key) => [key, shell[key]])
          ),
        };
      }),
  };
};

// A frame larger than MAX_FRAME_BYTES ends the connection, so a host with
// very many threads sends its snapshot without the listing details (counts
// and times stay) rather than not at all.
const SNAPSHOT_SOFT_LIMIT_BYTES = 6 * 1024 * 1024;
const fitSnapshot = (snapshot) => {
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= SNAPSHOT_SOFT_LIMIT_BYTES) return snapshot;
  return {
    ...snapshot,
    threads: snapshot.threads.map(({ summary: _summary, settings: _settings, ...thread }) => thread),
  };
};

// --- Attachments (host side) ---------------------------------------------

// The name a person sees (in the transcript); files on disk are named with
// sanitizeAttachmentName (media.js), a whitelist safe on every platform.
const safeAttachmentName = (value) => {
  const name = String(value ?? '')
    .replace(/[\\/\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return name || 'file';
};

const sanitizeSnapshotInfo = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  if (value.kind !== 'image' && value.kind !== 'accessibility') return undefined;
  return {
    kind: value.kind,
    appName: String(value.appName ?? '').slice(0, 200),
    windowTitle: String(value.windowTitle ?? '').slice(0, 300),
    ...(value.truncated === true ? { truncated: true } : {}),
  };
};

// When the session ends, files no turn used are deleted (unfinished ones, and
// finished ones whose turn never came or failed).
// (A command still running with some of them settles those itself.)
const discardUnfinishedUploads = (session) => {
  for (const upload of [...(session.uploads?.values?.() ?? [])]) {
    if (upload.claimed) continue;
    session.uploads.delete(upload.id);
    if (!upload.used) void fs.rm(upload.path, { force: true }).catch(() => {});
  }
};

const discardUpload = (session, upload) => {
  session.uploads.delete(upload.id);
  void fs.rm(upload.path, { force: true }).catch(() => {});
};

const settleUploadedAttachments = (session, attachments, succeeded) => {
  for (const attachment of attachments) {
    const upload = session.uploads.get(attachment.id);
    if (!upload) {
      settleResumableUpload(session, attachment.id, succeeded);
      continue;
    }
    if (succeeded) {
      upload.used = true;
      session.uploads.delete(upload.id);
    } else {
      discardUpload(session, upload);
    }
  }
};

// --- Resumable uploads (host side) ------------------------------------------
//
// Held per controller device rather than per session, so an upload survives a
// dropped connection and can be sent on a connection of its own while the
// thread's connection stays free. A command that names one claims it; when the
// command fails the upload goes back to waiting, because the controller keeps
// it for a retry (the file was often uploaded while the user was typing).
// Unused ones expire (scheduleResumableUploadExpiry).

const resumableUploadsOf = (deviceId) => {
  let uploads = deviceUploads.get(deviceId);
  if (!uploads) {
    uploads = new Map();
    deviceUploads.set(deviceId, uploads);
  }
  return uploads;
};

const findResumableUpload = (session, uploadId) =>
  deviceUploads.get(session.deviceId)?.get(String(uploadId ?? '')) ?? null;

const uploadTtl = (upload) => {
  const override = upload.done ? deps?.unclaimedUploadTtlMs : deps?.unfinishedUploadTtlMs;
  if (Number.isFinite(override)) return Math.max(1, override);
  return upload.done ? UNCLAIMED_UPLOAD_TTL_MS : UNFINISHED_UPLOAD_TTL_MS;
};

const scheduleResumableUploadExpiry = (upload) => {
  clearTimeout(upload.timer);
  upload.timer = null;
  if (upload.claimed || upload.discarded) return;
  upload.timer = setTimeout(() => discardResumableUpload(upload), uploadTtl(upload));
  upload.timer.unref?.();
};

const discardResumableUpload = (upload) => {
  if (upload.discarded) return;
  upload.discarded = true;
  clearTimeout(upload.timer);
  const uploads = deviceUploads.get(upload.deviceId);
  uploads?.delete(upload.id);
  if (uploads?.size === 0) deviceUploads.delete(upload.deviceId);
  const handle = upload.handle;
  upload.handle = null;
  void (async () => {
    await handle?.close().catch(() => {});
    if (!upload.used) await fs.rm(upload.path, { force: true }).catch(() => {});
  })();
};

/** Every resumable upload not claimed by a running command (of one device, or all). */
const discardResumableUploads = (deviceId = null) => {
  for (const [owner, uploads] of [...deviceUploads]) {
    if (deviceId && owner !== deviceId) continue;
    for (const upload of [...uploads.values()]) if (!upload.claimed) discardResumableUpload(upload);
  }
};

/**
 * At quit: files no command has used would be orphans (nothing would expire
 * them after a restart). A controller that still wants one finds it gone
 * (uploadStatus) and sends it again.
 */
const removeUnusedUploadFilesSync = () => {
  for (const uploads of deviceUploads.values()) {
    for (const upload of uploads.values()) {
      if (upload.used || upload.claimed) continue;
      try {
        fsSync.rmSync(upload.path, { force: true });
      } catch {}
    }
  }
};

const settleResumableUpload = (session, uploadId, succeeded) => {
  const upload = findResumableUpload(session, uploadId);
  if (!upload) return;
  upload.claimed = false;
  if (succeeded) {
    // The transcript that references the file keeps it.
    upload.used = true;
    discardResumableUpload(upload);
  } else {
    scheduleResumableUploadExpiry(upload);
  }
};

// upload.chunks[i]: CHUNK_MISSING, CHUNK_WRITING (a write is under way, in
// upload.writes), or CHUNK_WRITTEN. Only written chunks count as received.
const CHUNK_MISSING = 0;
const CHUNK_WRITING = 1;
const CHUNK_WRITTEN = 2;

/** Where a resumed upload continues: the end of the written chunks from the start. */
const contiguousUploadBytes = (upload) => {
  if (upload.done) return upload.size;
  const index = upload.chunks.findIndex((state) => state !== CHUNK_WRITTEN);
  return index === -1 ? upload.size : Math.min(upload.size, index * UPLOAD_CHUNK_BYTES);
};

/** FileHandle.write may write less than asked: write all of it. */
const writeFully = async (handle, buffer, position) => {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, position + written);
    if (!(bytesWritten > 0)) throw new Error('Could not write the attachment.');
    written += bytesWritten;
  }
};

const formatBytes = (bytes) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
};

const freeDiskBytes = async (directory) => {
  if (typeof deps?.freeDiskBytes === 'function') return deps.freeDiskBytes(directory);
  try {
    const stats = await fs.statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
};

const resumableUploadReply = (upload) => ({
  ok: true,
  uploadId: upload.id,
  chunkBytes: UPLOAD_CHUNK_BYTES,
  received: contiguousUploadBytes(upload),
  done: upload.done,
  ...(upload.done ? { path: upload.path } : {}),
});

/** Open a resumable upload: room for it is checked and the file made up front. */
const handleUploadOpen = async (session, message) => {
  if (typeof deps?.getAttachmentDirectoryPath !== 'function') {
    return { ok: false, error: 'This machine cannot receive attachments. Update Durango Code on it.' };
  }
  const size = Number(message?.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_REMOTE_ATTACHMENT_BYTES) {
    return { ok: false, error: 'This attachment is too large to send to another machine.' };
  }
  const uploads = resumableUploadsOf(session.deviceId);
  const waiting = [...uploads.values()].filter((upload) => !upload.claimed).length;
  if (waiting >= MAX_OPEN_UPLOADS) return { ok: false, error: 'Too many attachments at once.' };
  const id = crypto.randomUUID();
  const directory = deps.getAttachmentDirectoryPath();
  const name = sanitizeAttachmentName(message?.name);
  const upload = {
    id,
    deviceId: session.deviceId,
    name: safeAttachmentName(message?.name),
    mimeType: String(message?.mimeType ?? '').slice(0, 200) || 'application/octet-stream',
    size,
    // One byte per chunk (CHUNK_MISSING / CHUNK_WRITING / CHUNK_WRITTEN), and
    // the writes under way by chunk index.
    chunks: new Uint8Array(Math.ceil(size / UPLOAD_CHUNK_BYTES)),
    writes: new Map(),
    received: 0,
    done: size === 0,
    claimed: false,
    used: false,
    discarded: false,
    handle: null,
    timer: null,
    path: path.join(directory, `${id}-${name}`),
  };
  // Counted (and the slot taken) before any await, so concurrent opens cannot
  // get past the cap together.
  uploads.set(id, upload);
  try {
    await fs.mkdir(directory, { recursive: true });
    const free = await freeDiskBytes(directory);
    // Other uploads still arriving (from any controller) need their room too.
    let reserved = 0;
    for (const deviceUploadList of deviceUploads.values()) {
      for (const other of deviceUploadList.values()) {
        if (other !== upload && !other.done) reserved += other.size - other.received;
      }
    }
    if (Number.isFinite(free) && free - reserved < size + UPLOAD_DISK_HEADROOM_BYTES) {
      discardResumableUpload(upload);
      return {
        ok: false,
        error: `${identity?.machineName ?? 'That machine'} has ${formatBytes(Math.max(0, free - reserved))} of disk space free; ${upload.name} needs ${formatBytes(size)}.`,
      };
    }
    if (upload.done) {
      await fs.writeFile(upload.path, Buffer.alloc(0));
    } else {
      const handle = await fs.open(upload.path, 'w');
      // Discarded (device revoked, signed out) while it was being made: the
      // discard could not reach this handle or file.
      if (upload.discarded) {
        await handle.close().catch(() => {});
        await fs.rm(upload.path, { force: true }).catch(() => {});
        return { ok: false, error: 'The upload was cancelled.' };
      }
      upload.handle = handle;
    }
  } catch (error) {
    discardResumableUpload(upload);
    throw error;
  }
  if (upload.discarded) {
    await fs.rm(upload.path, { force: true }).catch(() => {});
    return { ok: false, error: 'The upload was cancelled.' };
  }
  scheduleResumableUploadExpiry(upload);
  return resumableUploadReply(upload);
};

/** One chunk, written where it belongs; repeats are acknowledged, not rewritten. */
const handleUploadChunk = async (session, message) => {
  const upload = findResumableUpload(session, message?.uploadId);
  if (!upload) return { ok: false, unknownUpload: true, error: 'Unknown attachment upload.' };
  if (upload.done) return resumableUploadReply(upload);
  const offset = Number(message?.offset);
  const chunk = typeof message?.data === 'string' ? Buffer.from(message.data, 'base64') : null;
  const index = offset / UPLOAD_CHUNK_BYTES;
  if (
    !chunk ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= upload.size ||
    !Number.isInteger(index) ||
    chunk.length !== Math.min(UPLOAD_CHUNK_BYTES, upload.size - offset)
  ) {
    return { ok: false, error: 'Invalid attachment chunk.' };
  }
  if (upload.chunks[index] === CHUNK_WRITING) {
    // Sent again (a resume) while the first copy is still being written:
    // answer once that write has settled, with what it left.
    await upload.writes.get(index)?.catch(() => {});
    if (upload.discarded) return { ok: false, unknownUpload: true, error: 'Unknown attachment upload.' };
    if (upload.chunks[index] !== CHUNK_WRITTEN) return { ok: false, error: 'Could not write the attachment.' };
    return resumableUploadReply(upload);
  }
  if (upload.chunks[index] === CHUNK_MISSING) {
    upload.chunks[index] = CHUNK_WRITING;
    scheduleResumableUploadExpiry(upload);
    const write = (async () => {
      // Tests slow uploads down enough to interrupt one.
      if (typeof deps?.beforeUploadChunk === 'function') await deps.beforeUploadChunk(offset);
      if (!upload.handle) throw new Error('The upload was cancelled.');
      await writeFully(upload.handle, chunk, offset);
    })();
    upload.writes.set(index, write);
    try {
      await write;
    } catch (error) {
      upload.chunks[index] = CHUNK_MISSING;
      if (upload.discarded) return { ok: false, unknownUpload: true, error: 'Unknown attachment upload.' };
      throw error;
    } finally {
      upload.writes.delete(index);
    }
    if (upload.discarded) return { ok: false, unknownUpload: true, error: 'Unknown attachment upload.' };
    upload.chunks[index] = CHUNK_WRITTEN;
    upload.received += chunk.length;
    if (upload.received === upload.size && !upload.done) {
      const handle = upload.handle;
      upload.handle = null;
      await handle?.close();
      upload.done = true;
      scheduleResumableUploadExpiry(upload);
    }
  }
  return resumableUploadReply(upload);
};

const handleUploadStatus = (session, message) => {
  const upload = findResumableUpload(session, message?.uploadId);
  if (!upload) return { ok: false, unknownUpload: true, error: 'Unknown attachment upload.' };
  return resumableUploadReply(upload);
};

/** The controller no longer wants these (removed from its prompt box). */
const handleUploadDiscard = (session, message) => {
  for (const uploadId of (Array.isArray(message?.uploadIds) ? message.uploadIds : []).slice(0, 64)) {
    const upload = findResumableUpload(session, uploadId);
    if (upload && !upload.claimed) discardResumableUpload(upload);
  }
  return { ok: true };
};

/**
 * One chunk of a file the controller attaches to a turn. The first chunk
 * (offset 0, no uploadId) opens the upload; chunks must arrive in order; the
 * one that reaches `size` completes it. The file lands in this machine's
 * attachment folder, like a file attached here, and stays there with the
 * transcript that references it.
 */
const handleAttachmentUpload = async (session, message) => {
  if (typeof deps?.getAttachmentDirectoryPath !== 'function') {
    return { ok: false, error: 'This machine cannot receive attachments. Update Durango Code on it.' };
  }
  const offset = Number(message?.offset);
  const chunk = typeof message?.data === 'string' ? Buffer.from(message.data, 'base64') : null;
  if (!chunk || !Number.isSafeInteger(offset) || offset < 0 || chunk.length > ATTACHMENT_CHUNK_BYTES) {
    return { ok: false, error: 'Invalid attachment chunk.' };
  }
  let upload;
  if (offset === 0 && !message?.uploadId) {
    const size = Number(message?.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > LEGACY_MAX_REMOTE_ATTACHMENT_BYTES) {
      return { ok: false, error: 'This attachment is too large to send to another machine.' };
    }
    // Counted (and the slot taken) before any await, so concurrent first
    // chunks cannot get past the cap together.
    const unused = [...session.uploads.values()].filter((candidate) => !candidate.used).length;
    if (unused >= MAX_OPEN_UPLOADS) return { ok: false, error: 'Too many attachments at once.' };
    const id = crypto.randomUUID();
    const directory = deps.getAttachmentDirectoryPath();
    upload = {
      id,
      name: safeAttachmentName(message?.name),
      mimeType: String(message?.mimeType ?? '').slice(0, 200) || 'application/octet-stream',
      size,
      written: 0,
      done: false,
      used: false,
      path: path.join(directory, `${id}-${sanitizeAttachmentName(message?.name)}`),
    };
    session.uploads.set(id, upload);
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(upload.path, Buffer.alloc(0));
    } catch (error) {
      discardUpload(session, upload);
      throw error;
    }
  } else {
    upload = session.uploads.get(String(message?.uploadId ?? ''));
    if (!upload || upload.done) return { ok: false, error: 'Unknown attachment upload.' };
  }
  if (offset !== upload.written || upload.written + chunk.length > upload.size) {
    discardUpload(session, upload);
    return { ok: false, error: 'Attachment chunks arrived out of order.' };
  }
  if (chunk.length > 0) {
    try {
      await fs.appendFile(upload.path, chunk);
    } catch (error) {
      discardUpload(session, upload);
      throw error;
    }
  }
  upload.written += chunk.length;
  if (upload.written === upload.size) upload.done = true;
  return {
    ok: true,
    uploadId: upload.id,
    done: upload.done,
    received: upload.written,
    ...(upload.done ? { path: upload.path } : {}),
  };
};

/**
 * The controller's attachments for a turn (or a reply), as files on this
 * machine. They stay the session's until the command that names them settles
 * (settleUploadedAttachments): kept with the transcript that references them
 * when it succeeded, deleted when it didn't.
 */
const resolveUploadedAttachments = (session, list) => {
  if (!Array.isArray(list) || list.length === 0) return [];
  const uploads = list.slice(0, 32).map((item) => {
    const uploadId = String(item?.uploadId ?? '');
    const upload = session.uploads.get(uploadId) ?? findResumableUpload(session, uploadId);
    if (!upload?.done || upload.claimed) throw new Error('An attachment did not finish uploading.');
    return { item, upload };
  });
  // Claimed together, after all were found: a missing one claims none.
  for (const { upload } of uploads) {
    if (upload.chunks) clearTimeout(upload.timer);
  }
  return uploads.map(({ item, upload }) => {
    // One command per upload: a second naming it is refused.
    upload.claimed = true;
    return {
      id: upload.id,
      name: safeAttachmentName(item?.name ?? upload.name),
      path: upload.path,
      mimeType: upload.mimeType,
      size: upload.size,
      ...(sanitizeSnapshotInfo(item?.snapshot) ? { snapshot: sanitizeSnapshotInfo(item.snapshot) } : {}),
    };
  });
};

/**
 * One chunk of an attachment of this machine's threads, so the controller can
 * show it. Only files in this machine's attachment folder are served.
 */
const handleAttachmentRead = async (message) => {
  if (typeof deps?.getAttachmentDirectoryPath !== 'function') {
    return { ok: false, error: 'This machine cannot share attachments. Update Durango Code on it.' };
  }
  const directory = path.resolve(deps.getAttachmentDirectoryPath());
  const requested = path.resolve(String(message?.path ?? ''));
  if (!requested.startsWith(directory + path.sep)) return { ok: false, error: 'Not an attachment.' };
  const offset = Number(message?.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return { ok: false, error: 'Invalid offset.' };
  let handle;
  try {
    const real = await fs.realpath(requested);
    if (!real.startsWith((await fs.realpath(directory)) + path.sep)) return { ok: false, error: 'Not an attachment.' };
    handle = await fs.open(real, 'r');
    const { size } = await handle.stat();
    if (size > MAX_MIRRORED_ATTACHMENT_BYTES) return { ok: false, error: 'This attachment is too large to fetch.' };
    if (offset > size) return { ok: false, error: 'Invalid offset.' };
    const length = Math.min(ATTACHMENT_CHUNK_BYTES, size - offset);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, offset);
    return {
      ok: true,
      size,
      offset,
      data: buffer.toString('base64'),
      nextOffset: offset + length < size ? offset + length : null,
    };
  } catch {
    return { ok: false, error: 'Attachment not found on the host.' };
  } finally {
    await handle?.close().catch(() => {});
  }
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

// A controller may pull a few large threads at once (one per open pane), so
// transfers are kept per thread, a few at most: the oldest goes first.
const MAX_THREAD_TRANSFERS = 2;

const dropThreadTransfer = (session, threadId) => {
  const transfer = session.threadTransfers?.get(threadId);
  if (!transfer) return;
  clearTimeout(transfer.expiryTimer);
  session.threadTransfers.delete(threadId);
};

const clearThreadTransfer = (session) => {
  for (const threadId of [...(session.threadTransfers?.keys() ?? [])]) dropThreadTransfer(session, threadId);
};

const retainThreadTransfer = (session, threadId, serialized) => {
  dropThreadTransfer(session, threadId);
  while (session.threadTransfers.size >= MAX_THREAD_TRANSFERS) {
    dropThreadTransfer(session, session.threadTransfers.keys().next().value);
  }
  const transfer = {
    threadId,
    serialized,
    version: crypto.createHash('sha256').update(serialized).digest('base64url'),
    expiryTimer: null,
  };
  transfer.expiryTimer = setTimeout(() => {
    if (session.threadTransfers.get(threadId) === transfer) session.threadTransfers.delete(threadId);
  }, THREAD_TRANSFER_TTL_MS);
  transfer.expiryTimer.unref?.();
  session.threadTransfers.set(threadId, transfer);
  return transfer;
};

const indexEntries = async () => {
  if (!deps?.readThreadsIndex) return [];
  try {
    const index = await deps.readThreadsIndex();
    return Array.isArray(index?.entries) ? index.entries : [];
  } catch {
    return [];
  }
};

const parentIdOf = (entry) => entry?.parentThreadId ?? entry?.shell?.parentThreadId ?? null;

/** A thread's subagent threads here, at any depth. */
const descendantThreadIds = async (threadId, entries = null) => {
  const all = entries ?? (await indexEntries());
  const children = new Map();
  for (const entry of all) {
    const parentId = parentIdOf(entry);
    if (!parentId) continue;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(entry.id);
  }
  const found = [];
  const queue = [threadId];
  const seen = new Set(queue);
  while (queue.length > 0 && found.length < 500) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
};

/**
 * The actions a thread or any of its subagents waits on the user for here,
 * each with the thread that asked (`ownerThreadId`): a controller shows them
 * on the thread it lists (it doesn't list subagents).
 */
const pendingUserActionsOf = async (threadId, entries = null) => {
  const all = entries ?? (await indexEntries());
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const ids = [threadId, ...(await descendantThreadIds(threadId, all))];
  return ids.flatMap((id) => {
    const actions = byId.get(id)?.shell?.userActions;
    return Array.isArray(actions) ? actions.map((action) => ({ ...action, ownerThreadId: id })) : [];
  });
};

// The stored version of a thread (its threads-index hash), so a controller
// that already has it can skip the transfer.
const storedThreadVersion = async (threadId) => {
  if (!deps?.readThreadsIndex) return null;
  try {
    const index = await deps.readThreadsIndex();
    const entry = (index?.entries ?? []).find((candidate) => candidate?.id === threadId);
    return typeof entry?.hash === 'string' ? entry.hash : null;
  } catch {
    return null;
  }
};

const threadResponseFitsFrame = (reqId, serialized) =>
  Buffer.byteLength(JSON.stringify({ t: 'res', reqId, ok: true, thread: null }), 'utf8') -
    Buffer.byteLength('null', 'utf8') +
    serialized.length +
    ENCRYPTED_FRAME_OVERHEAD_BYTES <=
  MAX_FRAME_BYTES;

// Shell commands running at once for one controller.
const MAX_EXECS_PER_SESSION = 16;

const handleExec = async (session, message) => {
  // The slot is taken before anything is awaited: the limit holds for
  // requests that arrive together, and an execCancel that comes while the
  // project is looked up still finds the command.
  if (session.execs.size >= MAX_EXECS_PER_SESSION) {
    return { ok: false, error: `${MAX_EXECS_PER_SESSION} commands are already running here for that machine.` };
  }
  const execId =
    typeof message?.execId === 'string' && message.execId && message.execId.length <= 128
      ? message.execId
      : crypto.randomUUID();
  if (session.execs.has(execId)) return { ok: false, error: 'A command with that id is already running.' };
  const controller = new AbortController();
  session.execs.set(execId, controller);
  try {
    // A project of this machine (its id, from the snapshot) is the base
    // folder for a relative cwd.
    let baseDir = null;
    if (typeof message?.projectId === 'string' && message.projectId) {
      const state = (await deps.readStoreState()) ?? {};
      const project = [
        ...(state.noProject ? [state.noProject] : []),
        ...(Array.isArray(state.projects) ? state.projects : []),
      ].find((candidate) => candidate?.id === message.projectId);
      if (!project?.path) return { ok: false, error: 'Project not found on this machine.' };
      baseDir = project.path;
    }
    return await runExecCommand({
      command: message?.command,
      cwd: typeof message?.cwd === 'string' ? message.cwd.slice(0, 4096) : undefined,
      baseDir,
      stdin: typeof message?.stdin === 'string' ? message.stdin : undefined,
      timeoutMs: Number(message?.timeoutMs),
      signal: AbortSignal.any([controller.signal, session.abortController.signal]),
      env: {
        DURANGO_REMOTE_MACHINE: String(session.device?.name ?? 'Remote').slice(0, 120),
      },
    });
  } finally {
    if (session.execs.get(execId) === controller) session.execs.delete(execId);
  }
};

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
  const acknowledgeClaim = (completionTimeoutMs, threadId = null) => {
    if (session.channel.closed) return;
    const claimedThreadId =
      typeof threadId === 'string' && threadId && threadId.length <= 128 ? threadId : null;
    // The turn's thread streams to this controller from the start (it can't
    // follow a new thread before it knows its id).
    if (claimedThreadId && session.followedThreads && session.followedThreads.size < 128) {
      session.followedThreads.add(claimedThreadId);
    }
    session.channel.send({
      t: 'claimed',
      reqId,
      completionTimeoutMs,
      ...(claimedThreadId ? { threadId: claimedThreadId } : {}),
    });
  };
  try {
    switch (message?.t) {
      case 'ping':
        respond({ ok: true });
        return;
      case 'snapshot':
        respond({ ok: true, snapshot: fitSnapshot(await buildSnapshot()) });
        return;
      case 'models':
        respond({ ok: true, models: buildModelCatalog(await deps.listAgentModels()) });
        return;
      case 'attachmentUpload':
        respond(await handleAttachmentUpload(session, message));
        return;
      case 'attachmentRead':
        respond(await handleAttachmentRead(message));
        return;
      case 'uploadOpen':
        respond(await handleUploadOpen(session, message));
        return;
      case 'uploadChunk':
        respond(await handleUploadChunk(session, message));
        return;
      case 'uploadStatus':
        respond(handleUploadStatus(session, message));
        return;
      case 'uploadDiscard':
        respond(handleUploadDiscard(session, message));
        return;
      case 'follow': {
        // The threads this controller shows: their streams come through.
        session.followedThreads = new Set(
          (Array.isArray(message?.threadIds) ? message.threadIds : [])
            .slice(0, 64)
            .map((id) => String(id).slice(0, 128))
        );
        respond({ ok: true });
        return;
      }
      case 'questions': {
        // The questions and approvals a thread's agent (or one of its
        // subagents) is waiting on here.
        const threadId = String(message?.threadId ?? '');
        const ids = [threadId, ...(await descendantThreadIds(threadId))];
        const questions = deps.listAgentQuestions
          ? (await Promise.all(ids.map((id) => deps.listAgentQuestions(id)))).flat()
          : null;
        if (!Array.isArray(questions)) {
          respond({ ok: false, error: 'This machine cannot share agent questions. Update Durango Code on it.' });
          return;
        }
        respond({ ok: true, questions });
        return;
      }
      case 'answerQuestion': {
        // Answered here exactly as this machine's own question card would.
        const answers = message?.answers;
        if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
          respond({ ok: false, error: 'Invalid answers.' });
          return;
        }
        const result = await requestRendererCommand(
          {
            kind: 'answerQuestion',
            threadId: String(message?.threadId ?? ''),
            runId: String(message?.runId ?? ''),
            requestId:
              typeof message?.requestId === 'number' ? message.requestId : String(message?.requestId ?? ''),
            answers: Object.fromEntries(
              Object.entries(answers)
                .slice(0, 50)
                .map(([key, values]) => [
                  String(key).slice(0, 200),
                  (Array.isArray(values) ? values : []).slice(0, 50).map((value) => String(value).slice(0, 20_000)),
                ])
            ),
            source: { machineId: session.deviceId, machineName: session.device?.name ?? 'Remote' },
          },
          Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS,
          session,
          acknowledgeClaim
        );
        respond(result);
        return;
      }
      case 'userAction': {
        // Done, Reply, Dismiss or Watch on an action a thread here asked for.
        const op = message?.op;
        if (op !== 'done' && op !== 'reply' && op !== 'dismiss' && op !== 'watch' && op !== 'secret') {
          respond({ ok: false, error: 'Invalid user action operation.' });
          return;
        }
        // A request_secret card's answer: the value (or a decline), for this
        // machine's agent, never stored on the controller.
        const secretAnswer =
          op !== 'secret'
            ? null
            : message?.secretAnswer?.type === 'save' && typeof message.secretAnswer.value === 'string'
              ? { type: 'save', value: message.secretAnswer.value.slice(0, 100_000) }
              : message?.secretAnswer?.type === 'decline'
                ? { type: 'decline' }
                : undefined;
        if (secretAnswer === undefined) {
          respond({ ok: false, error: 'Invalid secret answer.' });
          return;
        }
        let attachments;
        try {
          attachments = resolveUploadedAttachments(session, message?.attachments);
        } catch (error) {
          respond({ ok: false, error: error?.message ?? String(error) });
          return;
        }
        const result = await requestRendererCommand(
          {
            kind: 'userAction',
            threadId: String(message?.threadId ?? ''),
            actionId: String(message?.actionId ?? ''),
            op,
            ...(op === 'reply' ? { reply: String(message?.reply ?? '').slice(0, 200_000), attachments } : {}),
            ...(op === 'watch' ? { watching: message?.watching === true } : {}),
            ...(secretAnswer ? { secretAnswer } : {}),
            // A bot of the controller answering for the person (answer_thread_request):
            // shown with the answer, and never a secret card's.
            ...(op !== 'secret' && op !== 'watch' && typeof message?.answeredBy?.botName === 'string' && message.answeredBy.botName.trim()
              ? { answeredBy: { botName: message.answeredBy.botName.trim().slice(0, 80) } }
              : {}),
            source: { machineId: session.deviceId, machineName: session.device?.name ?? 'Remote' },
          },
          Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS,
          session,
          acknowledgeClaim
        );
        settleUploadedAttachments(session, attachments, result?.ok === true);
        respond(result);
        return;
      }
      case 'threadGit': {
        // Where a thread works on this machine: its branch (and workspace),
        // for the controller's prompt box.
        if (typeof deps?.threadGitState !== 'function') {
          respond({ ok: false, error: 'This machine cannot report branches. Update Durango Code on it.' });
          return;
        }
        respond(await deps.threadGitState(String(message?.threadId ?? '')));
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
          const transfer = session.threadTransfers.get(threadId);
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
        // The controller's copy is current: nothing to send.
        const storedVersion = await storedThreadVersion(threadId);
        if (storedVersion && typeof message?.knownVersion === 'string' && message.knownVersion === storedVersion) {
          respond({ ok: true, unchanged: true, storedVersion });
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
        const pendingUserActions = await pendingUserActionsOf(threadId);
        // Settled, snoozed and pinned, read with the status the thread
        // carries: the controller records it like a listing's, so an older
        // response never leaves the mirror filed differently for good.
        const sidebarState = Object.fromEntries(
          THREAD_SIDEBAR_STATE_KEYS.map((key) => [key, optionalString(thread[key])])
        );
        const directPayload = {
          ok: true,
          thread,
          pendingUserActions,
          sidebarState,
          ...(storedVersion ? { storedVersion } : {}),
        };
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
          pendingUserActions,
          sidebarState,
          ...(storedVersion ? { storedVersion } : {}),
        });
        return;
      }
      case 'runTurn': {
        const prompt = typeof message?.prompt === 'string' ? message.prompt.trim() : '';
        const hasAttachments = Array.isArray(message?.attachments) && message.attachments.length > 0;
        if (!prompt && !hasAttachments) {
          respond({ ok: false, error: 'Empty prompt.' });
          return;
        }
        let attachments;
        try {
          attachments = resolveUploadedAttachments(session, message?.attachments);
        } catch (error) {
          respond({ ok: false, error: error?.message ?? String(error) });
          return;
        }
        const result = await requestRendererCommand(
          {
            kind: 'runTurn',
            prompt: prompt.slice(0, 200_000),
            ...(attachments.length > 0 ? { attachments } : {}),
            // Context the agent gets but the transcript doesn't show: the
            // controller's copies of threads the prompt @-mentions that this
            // machine can't read itself.
            ...(typeof message?.context === 'string' && message.context.trim()
              ? { context: message.context.slice(0, MAX_TURN_CONTEXT_CHARS) }
              : {}),
            threadId: typeof message?.threadId === 'string' ? message.threadId : undefined,
            projectId: typeof message?.projectId === 'string' ? message.projectId : undefined,
            modelId: typeof message?.modelId === 'string' ? message.modelId : undefined,
            accessMode: sanitizeAccessMode(message?.accessMode),
            reasoningEffort: sanitizeReasoningEffort(message?.reasoningEffort),
            codexServiceTier: sanitizeCodexServiceTier(message?.codexServiceTier),
            claudeContextWindow: sanitizeClaudeContextWindow(message?.claudeContextWindow),
            source: { machineId: session.deviceId, machineName: session.device?.name ?? 'Remote' },
            // An agent of the controller sent this turn (machine_run_agent).
            // In a thread that agent created, its non-blocking questions go
            // back to that agent in the reply, not to a card here (App.tsx).
            ...(message?.fromAgent === true ? { fromAgent: true } : {}),
            // A new thread an agent of the controller started (machine_run_agent):
            // its subagent, listed back to that controller under the thread there.
            ...(typeof message?.spawnedBy?.threadId === 'string' &&
            message.spawnedBy.threadId &&
            message.spawnedBy.threadId.length <= 200 &&
            typeof message?.threadId !== 'string'
              ? {
                  spawnedBy: {
                    machineId: session.deviceId,
                    machineName: session.device?.name ?? 'Remote',
                    threadId: message.spawnedBy.threadId,
                  },
                }
              : {}),
          },
          Number.isFinite(deps?.runTurnTimeoutMs) ? Math.max(1, deps.runTurnTimeoutMs) : RUN_TURN_TIMEOUT_MS,
          session,
          acknowledgeClaim
        );
        settleUploadedAttachments(session, attachments, result?.ok === true);
        respond(result);
        return;
      }
      case 'checkoutSource': {
        // The controller wants to run in a Durango Source repository this
        // machine may not have: clone it (main/source-checkout.js), add it as
        // a project, and answer its project id for a following runTurn.
        if (typeof deps?.checkoutSourceProject !== 'function') {
          respond({ ok: false, error: 'This machine cannot check out Durango Source repositories. Update Durango Code on it.' });
          return;
        }
        const repoId = typeof message?.repoId === 'string' ? message.repoId : '';
        const name = typeof message?.name === 'string' ? message.name.slice(0, 200) : null;
        try {
          const project = await deps.checkoutSourceProject({ repoId, name });
          respond({ ok: true, projectId: project.id, projectName: project.name, path: project.path });
        } catch (error) {
          respond({ ok: false, error: error?.message ?? String(error) });
        }
        return;
      }
      case 'steerTurn': {
        // A message for the turn running here right now: delivered into it
        // like this machine's own "Steer now", or refused (never queued here).
        const prompt = typeof message?.prompt === 'string' ? message.prompt.trim() : '';
        const hasAttachments = Array.isArray(message?.attachments) && message.attachments.length > 0;
        if (!prompt && !hasAttachments) {
          respond({ ok: false, error: 'Empty prompt.' });
          return;
        }
        let attachments;
        try {
          attachments = resolveUploadedAttachments(session, message?.attachments);
        } catch (error) {
          respond({ ok: false, error: error?.message ?? String(error) });
          return;
        }
        const result = await requestRendererCommand(
          {
            kind: 'steerTurn',
            threadId: String(message?.threadId ?? ''),
            prompt: prompt.slice(0, 200_000),
            ...(attachments.length > 0 ? { attachments } : {}),
            source: { machineId: session.deviceId, machineName: session.device?.name ?? 'Remote' },
          },
          Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS,
          session,
          acknowledgeClaim
        );
        settleUploadedAttachments(session, attachments, result?.ok === true);
        respond(result);
        return;
      }
      case 'exec': {
        // A shell command (the controller's machine_exec agent tool). No
        // renderer in the loop: it is not a turn. A paired controller can
        // already start Full access turns here, so this grants nothing new.
        respond(await handleExec(session, message));
        return;
      }
      case 'execCancel': {
        session.execs.get(String(message?.execId ?? ''))?.abort();
        respond({ ok: true });
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
      case 'threadState': {
        // Settle, snooze or pin (or undo one) on a controller's mirror of a
        // thread here: this machine's sidebar files it the same way.
        const sidebarState = sanitizeThreadSidebarState(message?.state);
        if (!sidebarState) {
          respond({ ok: false, error: 'Invalid thread state.' });
          return;
        }
        const result = await requestRendererCommand(
          {
            kind: 'threadState',
            threadId: String(message?.threadId ?? '').slice(0, 128),
            sidebarState,
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

// Turn events every controller gets whatever it follows: a run started or
// ended, or a question asked or answered. The rest (streamed text, tool
// activity) go only to controllers following that thread.
const LIFECYCLE_EVENT_TYPES = new Set(['started', 'done', 'error', 'user-input']);

/**
 * Tap of agent turn events; forwarded so controllers can follow live runs.
 * A controller that named the threads it follows (`follow`) gets the stream
 * of those only; one that never did (app.durango.sh, older desktops) gets all.
 */
export const forwardAgentEventToRemote = (event) => {
  const runId = typeof event?.runId === 'string' ? event.runId : null;
  // Only the run's own thread writes into its message (subagent threads
  // have messages of their own).
  const tracked = runId ? runOutputs.get(runId) : undefined;
  const output = tracked && tracked.threadId === event?.threadId ? tracked : undefined;
  const ended = event?.type === 'done' || event?.type === 'error';
  if (ended && runId) runOutputs.delete(runId);
  // Numbered whether or not a controller is connected, so a controller
  // that joins mid-run sees it did not get the message from its start.
  const streamed = event?.type === 'chunk' || event?.type === 'activity';
  const streamSeq = output && streamed ? output.seq++ : undefined;
  if (hostSessions.size === 0) return;
  // The transcript message the run writes to here: a controller following
  // the thread streams text and tool activity straight into its copy of it,
  // as long as it got every one of them (streamSeq 0, 1, 2…).
  const payload = {
    t: 'event',
    kind: 'turnEvent',
    payload:
      output && event?.threadId
        ? { ...event, outputMessageId: output.messageId, ...(streamSeq !== undefined ? { streamSeq } : {}) }
        : event,
  };
  const lifecycle = LIFECYCLE_EVENT_TYPES.has(event?.type);
  let followedHere = false;
  for (const session of hostSessions) {
    if (!session.ready || session.channel.closed) continue;
    const followed = session.followedThreads;
    const following = !followed || followed.has(event?.threadId) || followed.has(event?.parentThreadId);
    if (!following && !lifecycle) continue;
    if (following) followedHere = true;
    session.channel.send(payload);
  }
  // Controllers read a finished run from the saved threads file, which a
  // running thread only reaches every few seconds: save it now.
  if (ended && followedHere && event?.threadId) deps?.flushRendererThreads?.();
};

// Which transcript message each agent run writes to (main.js agent:runTurn),
// and how many text/activity events it has streamed into it.
const runOutputs = new Map(); // runId -> { messageId, threadId, seq }
const MAX_TRACKED_RUN_OUTPUTS = 256;

/** The renderer started run `runId` of thread `threadId` writing into message `messageId`. */
export const noteAgentRunOutputMessage = (runId, messageId, threadId) => {
  if (typeof runId !== 'string' || !runId || runId.length > 128) return;
  if (typeof messageId !== 'string' || !messageId || messageId.length > 128) return;
  if (typeof threadId !== 'string' || !threadId) return;
  runOutputs.delete(runId);
  runOutputs.set(runId, { messageId, threadId, seq: 0 });
  // Runs that never report an end (failed starts) must not pile up.
  while (runOutputs.size > MAX_TRACKED_RUN_OUTPUTS) {
    runOutputs.delete(runOutputs.keys().next().value);
  }
};

/**
 * The run may write elsewhere from now on (a steer can continue it in a new
 * message): its events go out untagged, and controllers read the rest from
 * this machine's saved copy.
 */
export const forgetAgentRunOutputMessage = (runId) => {
  if (typeof runId === 'string') runOutputs.delete(runId);
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

const closeClientSession = (key, reason) => {
  const session = clientSessions.get(key);
  if (!session) return;
  clientSessions.delete(key);
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

/** Both of a machine's sessions: its threads' and its uploads'. */
const closeMachineSessions = (machineId, reason) => {
  closeClientSession(machineId, reason);
  closeClientSession(transferSessionKey(machineId), reason);
};

const clientSessionCanContinue = (machineId, session, machine) =>
  !shuttingDown &&
  settings.enabled &&
  Boolean(currentUserId) &&
  (session.route !== 'relay' || relayEnabled()) &&
  clientSessions.get(session.key ?? machineId) === session &&
  remoteMachines.includes(machine) &&
  (!machine.userId || machine.userId === currentUserId);

const cancelledClientSessionError = () =>
  new Error(settings.enabled ? 'The remote session was cancelled.' : 'Remote control is disabled in Settings.');

// ---------------------------------------------------------------------------
// Route selection (controller side).
//
// Direct first, then the local network, then the relay. Direct is the address
// the user typed. A machine paired over the relay has no such address, but
// each session's `welcome` says where the host listens on its own networks
// (machine.lan): those are dialed next, all at once and briefly, so two
// machines on the same network talk directly even though they paired over
// the internet. The relay is the fallback when neither answers. A local route
// that failed is skipped for a while (lanFailures), so a laptop away from home
// doesn't pay the timeout on every connection.

/** The learned local addresses worth dialing for a machine. */
const lanCandidates = (machine) => {
  const lan = machine.lan;
  if (!lan || !Number.isInteger(lan.port)) return [];
  const own = new Set(localAddresses());
  return lan.addresses.filter(
    (address) => !own.has(address) && !(machine.host === address && machine.port === lan.port)
  );
};

const clientRoutes = (machine) => {
  const routes = [];
  if (machine.host && Number.isInteger(machine.port)) routes.push('direct');
  const failedAt = lanFailures.get(machine.id);
  if (lanCandidates(machine).length > 0 && !(failedAt && Date.now() - failedAt < LAN_RETRY_AFTER_MS)) {
    routes.push('lan');
  }
  if (relayEnabled()) routes.push('relay');
  return routes;
};

/** A TCP connection to whichever of `addresses` answers first. */
const connectFirstAddress = (addresses, port, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    const sockets = [];
    let settled = false;
    let failures = 0;
    const settle = (error, winner = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      for (const socket of sockets) if (socket !== winner) socket.destroy();
      if (winner) resolve(winner);
      else reject(error);
    };
    const unreachable = () => new Error('Not reachable on its local network.');
    const onAbort = () => settle(cancelledClientSessionError());
    const timer = setTimeout(() => settle(unreachable()), timeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    for (const address of addresses) {
      const socket = net.connect({ host: address, port });
      sockets.push(socket);
      // Stays attached: a later error on a socket that lost the race (or on
      // the winner before its transport takes over) must not go unhandled.
      socket.on('error', () => {
        failures += 1;
        if (failures === addresses.length) settle(unreachable());
      });
      socket.once('connect', () => settle(null, socket));
    }
  });

const createControllerTransport = async (route, { host, port, machineId, machine }, signal) => {
  if (route === 'lan') {
    const candidates = lanCandidates(machine);
    const timeoutMs = Number.isFinite(deps?.lanConnectTimeoutMs) ? deps.lanConnectTimeoutMs : LAN_CONNECT_TIMEOUT_MS;
    const socket = await connectFirstAddress(candidates, machine.lan.port, timeoutMs, signal);
    return { ...wrapTcpSocket(socket), kind: 'tcp' };
  }
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
  cancelled: true,
  error:
    attempt?.cancelledReason ??
    (settings.enabled ? 'The pairing attempt was cancelled.' : 'Remote control is disabled in Settings.'),
});

/**
 * Pair with a host. Over the internet the pairing code is all the user types:
 * pass just `code` and the machine is found among this account's machines
 * (pairByCode). `host` + `port` reach a machine directly on the local network,
 * and `machineId` names a relay machine explicitly. Same pairing code, same
 * handshake, same account proof, same single-use semantics either way.
 */
export const pairWithRemoteHost = async ({ host, port, code, machineId } = {}) =>
  String(machineId ?? '').trim() || String(host ?? '').trim()
    ? pairWithTarget({ host, port, code, machineId })
    : pairByCode(code);

/**
 * Pair by code alone: ask Durango Cloud for this account's machines that are
 * online at the relay and offer the code to each until one accepts. Only a
 * machine showing a code can accept; one without an active code fails the
 * handshake at no cost to it (such attempts don't count toward its relay
 * rate limit, see the confirm stage). Machines this one has not paired with go first,
 * since re-pairing an already paired machine is the rare case. The account
 * proof still binds the pairing to this account, so the lookup only decides
 * where to knock.
 */
// The first release whose hosts don't count a pairing attempt without a live
// code toward their relay rate limit. Older hosts would be locked out of the
// relay by a few knocks, so they are not tried (pair with them by address).
export const PAIR_BY_CODE_MIN_VERSION = '1.0.190';

const versionParts = (value) =>
  String(value ?? '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));
const compareVersions = (left, right) => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (Number.isFinite(a[index]) ? a[index] : -1) - (Number.isFinite(b[index]) ? b[index] : -1);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * Whether a machine (by the version it registered with) can be offered a
 * code. A development build of this machine also tries machines on its own
 * version, so two builds of the same tree can pair.
 */
export const canOfferCodeTo = (machineVersion, ownVersion) => {
  const own = ownVersion && compareVersions(ownVersion, PAIR_BY_CODE_MIN_VERSION) < 0 ? ownVersion : PAIR_BY_CODE_MIN_VERSION;
  return Boolean(machineVersion) && compareVersions(machineVersion, own) >= 0;
};

const pairByCode = async (code) => {
  if (!identity) {
    return { ok: false, error: stateError ?? 'Remote control is unavailable on this machine.' };
  }
  if (!settings.enabled) {
    return { ok: false, error: 'Remote control is disabled in Settings.' };
  }
  if (!relayEnabled()) {
    return {
      ok: false,
      error:
        'Turn on “Connect over the internet” to pair with a code alone, or enter the other machine’s address.',
    };
  }
  if (normalizePairingCode(code).length < PAIRING_CODE_LENGTH) {
    return { ok: false, error: 'Enter the full pairing code shown on the other machine.' };
  }
  if (typeof deps?.listRelayDevices !== 'function') {
    return { ok: false, error: 'This build cannot look up your machines at Durango Cloud.' };
  }
  let devices;
  try {
    devices = await deps.listRelayDevices();
  } catch (error) {
    return { ok: false, error: `Could not list your machines at Durango Cloud: ${error?.message ?? error}` };
  }
  const paired = new Set(remoteMachines.map((machine) => machine.id));
  const online = (Array.isArray(devices) ? devices : []).filter(
    (device) =>
      typeof device?.machineId === 'string' &&
      device.machineId &&
      device.online === true &&
      device.machineId !== identity.machineId
  );
  const ownVersion = deps.getAppVersion?.() ?? null;
  const candidates = online
    .filter((device) => canOfferCodeTo(device.appVersion, ownVersion))
    .sort((left, right) => Number(paired.has(left.machineId)) - Number(paired.has(right.machineId)));
  if (candidates.length === 0) {
    const outdated = online.map((device) => device.name).filter(Boolean);
    return {
      ok: false,
      error:
        outdated.length > 0
          ? `Update Durango Code on ${outdated.join(', ')} to pair with a code alone (or pair by its address on your own network).`
          : 'None of your other machines is online over the internet. On the machine you want to control, turn on remote control and “Connect over the internet”, then generate a code.',
    };
  }
  // A machine that took the handshake (the code matched) and then failed says
  // why; that beats the handshake failures of the machines the code wasn't for.
  let specificError = null;
  for (const device of candidates) {
    const result = await pairWithTarget({ machineId: device.machineId, code });
    if (result.ok || result.cancelled || result.needsAuth) return result;
    if (result.error && !/^Could not pair:/.test(result.error)) specificError = result.error;
  }
  return {
    ok: false,
    error: specificError ?? 'None of your machines accepted that code. Check it and that it has not expired.',
  };
};

const pairWithTarget = async ({ host, port, code, machineId } = {}) => {
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
  if (normalizedCode.length < PAIRING_CODE_LENGTH) return { ok: false, error: 'Enter the full pairing code.' };

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
        ? `Could not pair: ${error?.message ?? error}. Check the code, and that the other machine is online over the internet.`
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
  cancelHostUploadTransfers('This machine was removed.', id);
  closeMachineSessions(id, null);
  publishState();
  return { ok: true };
};

/**
 * The machine's session: the one that carries its threads, or with `transfer`
 * a second one that carries uploads, so a large file doesn't hold up the
 * thread's streamed events behind it. The transfer session closes itself when
 * unused (TRANSFER_SESSION_IDLE_MS).
 */
const ensureClientSession = async (machineId, { transfer = false } = {}) => {
  if (!identity) throw new Error(stateError ?? 'Remote control is unavailable on this machine.');
  if (!settings.enabled) throw new Error('Remote control is disabled in Settings.');
  await refreshAccount();
  if (!currentUserId) throw new Error('Sign in to your Durango account first.');
  const machine = remoteMachines.find((candidate) => candidate.id === machineId);
  if (!machine) throw new Error('This machine is not paired.');
  if (machine.userId && machine.userId !== currentUserId) {
    throw new Error('This machine was paired under a different Durango account.');
  }

  const key = transfer ? transferSessionKey(machineId) : machineId;
  const existing = clientSessions.get(key);
  if (existing?.ready) return existing;
  if (existing?.connectPromise) return existing.connectPromise;

  const session = {
    key,
    transfer,
    machineId,
    hostFeatures: new Set(),
    channel: null,
    ready: false,
    connecting: true,
    lastError: null,
    pending: new Map(), // reqId -> { resolve, reject, timer }
    connectPromise: null,
    route: null,
    abortController: new AbortController(),
  };
  clientSessions.set(key, session);
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
              machine,
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
        if (route === 'lan') lanFailures.delete(machine.id);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // A cancelled session is not a routing failure — do not try the next
        // route after remote control has been switched off underneath us.
        if (!clientSessionCanContinue(machineId, session, machine)) break;
        if (route === 'lan') lanFailures.set(machine.id, Date.now());
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
        if (pending?.onClaimed && typeof message.threadId === 'string' && message.threadId && message.threadId.length <= 128) {
          try {
            pending.onClaimed(message.threadId);
          } catch {}
        }
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
      // The transfer session gets the host's lifecycle events too; the
      // thread's session already delivered them.
      if (message?.t === 'event' && !session.transfer) {
        const event = { machineId, kind: message.kind, payload: message.payload ?? null };
        deps.broadcast('remote:event', event);
        notifyRemoteEventListeners(event);
      }
    };
    while (beforeRouter.length > 0) routeMessage(beforeRouter.shift());
    channel.onClose(() => {
      if (clientSessions.get(key) === session) {
        clientSessions.delete(key);
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
    if (channel.closed || clientSessions.get(key) !== session) {
      throw new Error(session.lastError ?? 'Disconnected from the host.');
    }

    session.hostFeatures = new Set(
      (Array.isArray(welcome.features) ? welcome.features : []).slice(0, 32).map(String)
    );
    // Refresh the display name and the local route we hold for the host.
    const previous = { name: machine.name, lan: machine.lan };
    let changed = false;
    if (typeof welcome.machine?.name === 'string' && welcome.machine.name && welcome.machine.name !== machine.name) {
      machine.name = welcome.machine.name.slice(0, 120);
      changed = true;
    }
    if (session.hostFeatures.has('lan')) {
      const lan = sanitizeLanRoute(welcome.lan);
      if (JSON.stringify(lan) !== JSON.stringify(machine.lan ?? null)) {
        machine.lan = lan;
        lanFailures.delete(machine.id);
        changed = true;
      }
    }
    if (changed) {
      void savePersistedState().catch(() => {
        machine.name = previous.name;
        machine.lan = previous.lan;
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
  { extendOnClaim = false, signal, onDispatch, onClaimed, transfer = false } = {}
) => {
  const session = await ensureClientSession(machineId, { transfer });
  // Stopped while connecting: never sent.
  if (signal?.aborted) throw new Error('Cancelled before it started.');
  // `await ensureClientSession` yields even for an already-ready session. The
  // settings/account reconciliation may close it during that gap, so dispatch
  // must verify live ownership instead of sending on the stale object.
  if (
    !settings.enabled ||
    (session.route === 'relay' && !relayEnabled()) ||
    clientSessions.get(session.key) !== session ||
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
    pending = { resolve, reject, timer, onTimeout, extendOnClaim, claimed: false, onClaimed };
    session.pending.set(reqId, pending);
    session.channel.send({ ...message, reqId });
    onDispatch?.();
  });
};

const clientErrorResult = (error) => ({ ok: false, error: error?.message ?? String(error) });

// Main-process taps on events pushed by the machines this one controls
// (machine-tools.js waits on a remote turn's end through them).
const remoteEventListeners = new Set();
export const addRemoteEventListener = (listener) => {
  remoteEventListeners.add(listener);
  return () => remoteEventListeners.delete(listener);
};
const notifyRemoteEventListeners = (event) => {
  for (const listener of remoteEventListeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('remote event listener error', error);
    }
  }
};

/**
 * Whether this machine can drive another one now: remote control is on and
 * at least one machine is paired (whether or not it is online).
 */
export const canControlRemoteMachines = () =>
  Boolean(stateLoaded && identity && settings.enabled && currentUserId && remoteMachines.length > 0);

export const connectRemoteMachine = async ({ machineId } = {}) => {
  try {
    await ensureClientSession(String(machineId ?? ''));
    return { ok: true };
  } catch (error) {
    return clientErrorResult(error);
  }
};

export const disconnectRemoteMachine = ({ machineId } = {}) => {
  closeMachineSessions(String(machineId ?? ''), null);
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

/**
 * A paired host's thread. With `knownVersion` (the storedVersion of the copy
 * this machine has), a host that still has that version answers
 * `{ unchanged: true }` instead of sending it again.
 */
export const fetchRemoteThread = async ({ machineId, threadId, knownVersion } = {}) => {
  try {
    const targetMachineId = String(machineId ?? '');
    const targetThreadId = String(threadId ?? '');
    const chunks = [];
    let expectedOffset;
    let expectedVersion;
    let expectedBytes;
    let storedVersion;
    let pendingUserActions;
    let sidebarState;
    for (;;) {
      const response = await clientRequest(targetMachineId, {
        t: 'thread',
        threadId: targetThreadId,
        threadChunking: true,
        ...(expectedOffset === undefined && typeof knownVersion === 'string' && knownVersion
          ? { knownVersion: knownVersion.slice(0, 200) }
          : {}),
        ...(expectedOffset === undefined ? {} : { threadOffset: expectedOffset }),
        ...(expectedVersion === undefined ? {} : { threadVersion: expectedVersion }),
      });
      if (!response.ok) return { ok: false, error: response.error ?? 'Thread fetch failed.' };
      if (expectedOffset === undefined && typeof response.storedVersion === 'string') {
        storedVersion = response.storedVersion.slice(0, 200);
      }
      if (response.unchanged === true && expectedOffset === undefined) {
        return { ok: true, unchanged: true, storedVersion };
      }
      // Ordinary and older hosts return the complete thread in one response.
      if (expectedOffset === undefined && Array.isArray(response.pendingUserActions)) {
        pendingUserActions = response.pendingUserActions;
      }
      // Absent from older hosts: the mirror then keeps what listings say.
      if (expectedOffset === undefined) sidebarState = sanitizeThreadSidebarState(response.sidebarState) ?? undefined;
      const extras = () => ({
        ...(storedVersion ? { storedVersion } : {}),
        ...(pendingUserActions ? { pendingUserActions } : {}),
        ...(sidebarState ? { sidebarState } : {}),
      });
      if (response.thread !== undefined && expectedOffset === undefined) {
        return { ok: true, thread: response.thread, ...extras() };
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
        return { ok: true, thread, ...extras() };
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

// --- Uploads (controller side) ------------------------------------------------
//
// One transfer per machine and file (as the file is now: path, size, mtime).
// The prompt box starts it as soon as a file is attached to a thread on
// another machine (prepareRemoteAttachmentUpload), so a large file is often
// there by the time the turn is sent; the command that sends the file waits
// for the same transfer (uploadAttachmentToHost). Hosts with resumable uploads
// (`uploads2`) get chunks several at a time over a session of their own, and a
// dropped connection resumes where the host's copy stops; older hosts get the
// original one-chunk-at-a-time upload on the thread's session, up to the size
// they accept. Progress goes to the renderer as `remote:uploadProgress`.

const hostUploadTransfers = new Map(); // key -> transfer
const UPLOAD_PROGRESS_INTERVAL_MS = 250;

/** A refusal from the host (or a problem with the file): retrying won't help. */
class UploadRefusal extends Error {}
/** A prompt-box upload to a host without resumable uploads: sent with the turn instead. */
class DeferredUpload extends Error {}

const TRANSIENT_UPLOAD_ERROR =
  /Disconnected|did not respond in time|Could not reach|closed the connection|timed out|was lost on the host|not reading data/i;

const hostUploadKey = (machineId, localPath, size, mtimeMs) =>
  [machineId, localPath, size, mtimeMs].join('\u0000');

const publishUploadProgress = (transfer, force = false) => {
  const now = Date.now();
  if (!force && now - transfer.publishedAt < UPLOAD_PROGRESS_INTERVAL_MS) {
    // Throttled, not dropped: the latest value goes out at the end of the window.
    if (!transfer.publishTimer) {
      transfer.publishTimer = setTimeout(() => {
        transfer.publishTimer = null;
        if (transfer.state === 'uploading') publishUploadProgress(transfer, true);
      }, UPLOAD_PROGRESS_INTERVAL_MS - (now - transfer.publishedAt));
      transfer.publishTimer.unref?.();
    }
    return;
  }
  clearTimeout(transfer.publishTimer);
  transfer.publishTimer = null;
  transfer.publishedAt = now;
  deps?.broadcast?.('remote:uploadProgress', {
    machineId: transfer.machineId,
    machineName: machineDisplayName(transfer.machineId),
    path: transfer.localPath,
    size: transfer.size,
    sent: transfer.sent,
    state: transfer.state,
    route: transfer.route ?? null,
    ...(transfer.error ? { error: transfer.error } : {}),
  });
};

// Chunks in flight per machine, shared by every upload to it: the transports
// close a connection whose unsent data passes MAX_PENDING_WRITE_BYTES.
const uploadSlots = new Map(); // machineId -> { free, waiters }

const acquireUploadSlot = (machineId, signal) => {
  let slots = uploadSlots.get(machineId);
  if (!slots) {
    slots = { free: UPLOAD_WINDOW_CHUNKS, waiters: [] };
    uploadSlots.set(machineId, slots);
  }
  return acquireFrom(slots, signal);
};

const acquireFrom = (slots, signal) => {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('The upload was cancelled.'));
  if (slots.free > 0) {
    slots.free -= 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve: () => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve();
      },
    };
    const onAbort = () => {
      const index = slots.waiters.indexOf(waiter);
      if (index === -1) return;
      slots.waiters.splice(index, 1);
      reject(signal.reason ?? new Error('The upload was cancelled.'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    slots.waiters.push(waiter);
  });
};

const releaseUploadSlot = (machineId) => releaseTo(uploadSlots.get(machineId), UPLOAD_WINDOW_CHUNKS);

const releaseTo = (slots, capacity) => {
  if (!slots) return;
  const next = slots.waiters.shift();
  if (next) next.resolve();
  else slots.free = Math.min(capacity, slots.free + 1);
};

// Uploads to hosts without resumable uploads use 3 MiB chunks (4 MiB of
// base64) on the thread's own session: at most two of those in flight per
// machine, whatever the number of files.
const LEGACY_UPLOAD_WINDOW_CHUNKS = 2;
const legacyUploadSlots = new Map(); // machineId -> { free, waiters }

const acquireLegacyUploadSlot = (machineId, signal) => {
  let slots = legacyUploadSlots.get(machineId);
  if (!slots) {
    slots = { free: LEGACY_UPLOAD_WINDOW_CHUNKS, waiters: [] };
    legacyUploadSlots.set(machineId, slots);
  }
  return acquireFrom(slots, signal);
};

const releaseLegacyUploadSlot = (machineId) => releaseTo(legacyUploadSlots.get(machineId), LEGACY_UPLOAD_WINDOW_CHUNKS);

// The transfer session closes once no upload to the machine has needed it for
// a while.
const activeUploadCounts = new Map(); // machineId -> uploads running
const transferIdleTimers = new Map(); // machineId -> timer

const noteUploadActivity = (machineId, delta) => {
  const count = (activeUploadCounts.get(machineId) ?? 0) + delta;
  clearTimeout(transferIdleTimers.get(machineId));
  transferIdleTimers.delete(machineId);
  if (count > 0) {
    activeUploadCounts.set(machineId, count);
    return;
  }
  activeUploadCounts.delete(machineId);
  const idleMs = Number.isFinite(deps?.transferSessionIdleMs) ? deps.transferSessionIdleMs : TRANSFER_SESSION_IDLE_MS;
  const timer = setTimeout(() => {
    transferIdleTimers.delete(machineId);
    if (!activeUploadCounts.get(machineId)) closeClientSession(transferSessionKey(machineId), null);
  }, idleMs);
  timer.unref?.();
  transferIdleTimers.set(machineId, timer);
};

const waitFor = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('The upload was cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('The upload was cancelled.'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

const machineDisplayName = (machineId) =>
  remoteMachines.find((machine) => machine.id === machineId)?.name ?? 'That machine';

/** Read one chunk of the file being sent; a file that shrank under us is refused. */
const readUploadChunk = async (transfer, handle, offset, length) => {
  const buffer = Buffer.alloc(length);
  if (length === 0) return buffer;
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  if (bytesRead !== length) throw new UploadRefusal(`${transfer.name} changed while it was being sent.`);
  return buffer;
};

/** Hosts without resumable uploads: one chunk at a time on the thread's session. */
const sendLegacyUpload = async (transfer) => {
  if (transfer.size > LEGACY_MAX_REMOTE_ATTACHMENT_BYTES) {
    throw new UploadRefusal(
      `${transfer.name} is too large for ${machineDisplayName(transfer.machineId)} (100 MB at most). Update Durango Code there to send larger files.`
    );
  }
  transfer.route = clientSessions.get(transfer.machineId)?.route ?? null;
  const handle = await fs.open(transfer.localPath, 'r');
  try {
    let uploadId;
    let offset = 0;
    for (;;) {
      const length = Math.min(ATTACHMENT_CHUNK_BYTES, transfer.size - offset);
      const buffer = await readUploadChunk(transfer, handle, offset, length);
      await acquireLegacyUploadSlot(transfer.machineId, transfer.signal);
      let response;
      try {
        response = await clientRequest(transfer.machineId, {
          t: 'attachmentUpload',
          ...(uploadId ? { uploadId } : { name: transfer.name, mimeType: transfer.mimeType, size: transfer.size }),
          offset,
          data: buffer.toString('base64'),
        });
      } finally {
        releaseLegacyUploadSlot(transfer.machineId);
      }
      if (!response.ok) {
        throw new UploadRefusal(
          response.error === 'Unsupported request.'
            ? 'That machine cannot receive attachments yet. Update Durango Code on it.'
            : (response.error ?? 'The attachment could not be sent.')
        );
      }
      uploadId = response.uploadId;
      offset += length;
      transfer.sent = offset;
      publishUploadProgress(transfer);
      if (response.done) return { uploadId, hostPath: typeof response.path === 'string' ? response.path : null };
      if (length === 0 || response.received !== offset) throw new UploadRefusal('The host did not accept the attachment.');
      if (transfer.signal.aborted) throw transfer.signal.reason ?? new Error('The upload was cancelled.');
    }
  } finally {
    await handle.close().catch(() => {});
  }
};

/** One pass of a resumable upload: open it (or find where the host's copy stops), then send the rest. */
const sendResumableUpload = async (transfer) => {
  const request = (message, timeoutMs = REQUEST_TIMEOUT_MS) =>
    clientRequest(transfer.machineId, message, timeoutMs, { transfer: true, signal: transfer.signal });
  const finished = (response) => ({
    uploadId: transfer.uploadId,
    hostPath: typeof response.path === 'string' ? response.path : null,
  });
  const stats = await fs.stat(transfer.localPath);
  if (stats.size !== transfer.size || stats.mtimeMs !== transfer.mtimeMs) {
    throw new UploadRefusal(`${transfer.name} changed while it was being sent. Attach it again.`);
  }
  let start = 0;
  if (transfer.uploadId) {
    const status = await request({ t: 'uploadStatus', uploadId: transfer.uploadId });
    if (status.ok) {
      if (status.done) return finished(status);
      start = Number.isSafeInteger(status.received) ? status.received : 0;
    } else if (status.unknownUpload) {
      transfer.uploadId = null;
    } else {
      throw new UploadRefusal(status.error ?? 'The attachment could not be sent.');
    }
  }
  if (!transfer.uploadId) {
    const opened = await request({
      t: 'uploadOpen',
      name: transfer.name,
      mimeType: transfer.mimeType,
      size: transfer.size,
    });
    if (!opened.ok) throw new UploadRefusal(opened.error ?? 'The attachment could not be sent.');
    // Cancelled while the host was opening it: the cancel could not name it.
    if (transfer.signal.aborted) {
      void clientRequest(transfer.machineId, { t: 'uploadDiscard', uploadIds: [String(opened.uploadId)] }, REQUEST_TIMEOUT_MS, {
        transfer: true,
      }).catch(() => {});
      throw transfer.signal.reason ?? new Error('The upload was cancelled.');
    }
    if (opened.chunkBytes !== UPLOAD_CHUNK_BYTES) throw new UploadRefusal('That machine expects a different upload format. Update Durango Code on both machines.');
    transfer.uploadId = String(opened.uploadId);
    if (opened.done) return finished(opened);
    start = 0;
  }
  if (start % UPLOAD_CHUNK_BYTES !== 0 || start > transfer.size) throw new Error('The upload was lost on the host.');
  transfer.route = clientSessions.get(transferSessionKey(transfer.machineId))?.route ?? null;
  transfer.sent = start;
  publishUploadProgress(transfer, true);

  const uploadId = transfer.uploadId;
  const handle = await fs.open(transfer.localPath, 'r');
  const inFlight = new Set();
  let failure = null;
  let last = null;
  try {
    for (let offset = start; offset < transfer.size && !failure; offset += UPLOAD_CHUNK_BYTES) {
      await acquireUploadSlot(transfer.machineId, transfer.signal);
      if (failure) {
        releaseUploadSlot(transfer.machineId);
        break;
      }
      const chunkOffset = offset;
      const length = Math.min(UPLOAD_CHUNK_BYTES, transfer.size - chunkOffset);
      const task = (async () => {
        try {
          const buffer = await readUploadChunk(transfer, handle, chunkOffset, length);
          const response = await request(
            { t: 'uploadChunk', uploadId, offset: chunkOffset, data: buffer.toString('base64') },
            Number.isFinite(deps?.uploadChunkTimeoutMs) ? deps.uploadChunkTimeoutMs : UPLOAD_CHUNK_TIMEOUT_MS
          );
          if (!response.ok) {
            if (response.unknownUpload) {
              transfer.uploadId = null;
              throw new Error('The upload was lost on the host.');
            }
            throw new UploadRefusal(response.error ?? 'The attachment could not be sent.');
          }
          transfer.sent = Math.min(transfer.size, transfer.sent + length);
          publishUploadProgress(transfer);
          if (response.done) last = response;
        } finally {
          releaseUploadSlot(transfer.machineId);
        }
      })().catch((error) => {
        failure ??= error;
      });
      inFlight.add(task);
      void task.then(() => inFlight.delete(task));
    }
  } catch (error) {
    failure ??= error;
  } finally {
    await Promise.all([...inFlight]);
    await handle.close().catch(() => {});
  }
  if (failure) throw failure;
  if (!last) {
    const status = await request({ t: 'uploadStatus', uploadId });
    if (!status.ok || !status.done) throw new Error('The upload was lost on the host.');
    last = status;
  }
  return finished(last);
};

const runHostUpload = async (transfer) => {
  noteUploadActivity(transfer.machineId, 1);
  try {
    const session = await ensureClientSession(transfer.machineId);
    if (!session.hostFeatures.has('uploads2')) {
      if (transfer.prepared) throw new DeferredUpload('Sent with the turn.');
      return await sendLegacyUpload(transfer);
    }
    transfer.resumable = true;
    let lastError = null;
    for (let attempt = 0; attempt < UPLOAD_RESUME_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await waitFor(Math.min(8000, 500 * 2 ** attempt), transfer.signal);
      try {
        return await sendResumableUpload(transfer);
      } catch (error) {
        if (transfer.signal.aborted || error instanceof UploadRefusal) throw error;
        if (!TRANSIENT_UPLOAD_ERROR.test(error?.message ?? '')) throw error;
        lastError = error;
      }
    }
    throw lastError;
  } finally {
    noteUploadActivity(transfer.machineId, -1);
  }
};

/**
 * The transfer of this file to this machine: the one under way (or done), or a
 * new one. `claim` takes it for a command (counted before this returns): a
 * host lets one command use an upload, so a second command sending the same
 * file at the same time gets a transfer of its own.
 */
const startHostUpload = async (machineId, attachment, { prepared = false, claim = false } = {}) => {
  const localPath = String(attachment?.path ?? '');
  const name = String(attachment?.name ?? path.basename(localPath));
  const stats = await fs.stat(localPath);
  if (!stats.isFile()) throw new Error(`${name} is not a file.`);
  const baseKey = hostUploadKey(machineId, localPath, stats.size, stats.mtimeMs);
  const existing = hostUploadTransfers.get(baseKey);
  if (existing && (existing.state === 'uploading' || existing.state === 'done') && !(claim && existing.users > 0)) {
    if (claim) existing.users += 1;
    return existing;
  }
  const key = existing && claim && existing.users > 0 ? `${baseKey}\u0000${crypto.randomUUID()}` : baseKey;
  const abortController = new AbortController();
  const transfer = {
    key,
    machineId,
    localPath,
    name,
    mimeType: typeof attachment?.mimeType === 'string' ? attachment.mimeType : undefined,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sent: 0,
    state: 'uploading',
    error: null,
    uploadId: null,
    resumable: false,
    prepared,
    users: claim ? 1 : 0,
    publishedAt: 0,
    publishTimer: null,
    route: null,
    abortController,
    signal: abortController.signal,
  };
  hostUploadTransfers.set(key, transfer);
  publishUploadProgress(transfer, true);
  transfer.promise = runHostUpload(transfer).then(
    (result) => {
      transfer.state = 'done';
      transfer.sent = transfer.size;
      publishUploadProgress(transfer, true);
      return result;
    },
    (error) => {
      if (error instanceof DeferredUpload) {
        if (hostUploadTransfers.get(key) === transfer) hostUploadTransfers.delete(key);
        transfer.state = 'deferred';
      } else {
        transfer.state = transfer.signal.aborted ? 'cancelled' : 'error';
        transfer.error = error?.message ?? String(error);
      }
      publishUploadProgress(transfer, true);
      throw error;
    }
  );
  // A prompt-box upload may never be awaited.
  transfer.promise.catch(() => {});
  return transfer;
};

/**
 * Send one local file to a paired host for a command → { uploadId, hostPath,
 * transfer }. Settle the transfer with settleHostUploads once the command
 * that names it has an answer.
 */
const uploadAttachmentToHost = async (machineId, attachment) => {
  for (let attempt = 0; ; attempt += 1) {
    const transfer = await startHostUpload(machineId, attachment, { claim: true });
    const reused = transfer.state === 'done';
    try {
      const result = await transfer.promise;
      // Uploaded a while ago (from the prompt box): make sure the host still
      // has it (it drops unused files after a while, and on restart).
      if (reused && transfer.resumable && attempt === 0) {
        const status = await clientRequest(machineId, { t: 'uploadStatus', uploadId: result.uploadId }, REQUEST_TIMEOUT_MS, {
          transfer: true,
        }).catch(() => null);
        if (status && !(status.ok && status.done)) {
          transfer.users -= 1;
          if (hostUploadTransfers.get(transfer.key) === transfer) hostUploadTransfers.delete(transfer.key);
          continue;
        }
      }
      return { ...result, transfer };
    } catch (error) {
      transfer.users -= 1;
      // Started from the prompt box for a host that takes files only with the
      // turn: send it now, the original way.
      if (error instanceof DeferredUpload && attempt === 0) continue;
      throw error;
    }
  }
};

/** Every file of a command, at once (they share the machine's chunk slots). */
const uploadAttachmentsToHost = async (machineId, attachments) => {
  const list = Array.isArray(attachments) ? attachments.slice(0, 32) : [];
  const settled = await Promise.allSettled(list.map((attachment) => uploadAttachmentToHost(machineId, attachment)));
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) {
    settleHostUploads(
      settled.filter((result) => result.status === 'fulfilled').map((result) => result.value),
      { ok: false }
    );
    throw failed.reason;
  }
  return settled.map((result, index) => ({ ...result.value, attachment: list[index] }));
};

/**
 * The command that named these uploads has answered. The host keeps a file it
 * used; one a failed command named stays there for a retry (resumable hosts),
 * so it stays known here too, unless the host no longer has it.
 */
const settleHostUploads = (uploads, { ok, error } = {}) => {
  const lostOnHost = !ok && /did not finish uploading/i.test(String(error ?? ''));
  for (const upload of uploads) {
    const transfer = upload?.transfer;
    if (!transfer) continue;
    transfer.users = Math.max(0, transfer.users - 1);
    if (hostUploadTransfers.get(transfer.key) !== transfer) continue;
    if (ok || lostOnHost || !transfer.resumable) {
      hostUploadTransfers.delete(transfer.key);
      transfer.state = ok ? 'sent' : transfer.state;
      if (ok) publishUploadProgress(transfer, true);
    }
  }
};

/** Abort transfers (all, or one machine's), e.g. when a machine is removed. */
const cancelHostUploadTransfers = (reason, machineId = null) => {
  for (const transfer of [...hostUploadTransfers.values()]) {
    if (machineId && transfer.machineId !== machineId) continue;
    hostUploadTransfers.delete(transfer.key);
    transfer.abortController.abort(new Error(reason));
  }
};

/**
 * The prompt box got a file for a thread on `machineId`: start sending it now
 * so the turn doesn't wait for it. Progress arrives as remote:uploadProgress.
 */
export const prepareRemoteAttachmentUpload = async ({ machineId, attachment } = {}) => {
  try {
    await startHostUpload(String(machineId ?? ''), attachment, { prepared: true });
    return { ok: true };
  } catch (error) {
    return clientErrorResult(error);
  }
};

/**
 * The file was taken out of the prompt box (or the thread moved to another
 * machine): stop sending it and let the host drop its copy. A file a command
 * is sending right now is left alone.
 */
export const cancelRemoteAttachmentUpload = ({ machineId, path: localPath } = {}) => {
  const targetMachineId = String(machineId ?? '');
  for (const transfer of [...hostUploadTransfers.values()]) {
    if (transfer.machineId !== targetMachineId || transfer.localPath !== String(localPath ?? '')) continue;
    if (transfer.users > 0) continue;
    hostUploadTransfers.delete(transfer.key);
    const wasUploading = transfer.state === 'uploading';
    transfer.abortController.abort(new Error('The upload was cancelled.'));
    if (transfer.resumable && transfer.uploadId) {
      void clientRequest(targetMachineId, { t: 'uploadDiscard', uploadIds: [transfer.uploadId] }, REQUEST_TIMEOUT_MS, {
        transfer: true,
      }).catch(() => {});
    }
    if (!wasUploading) {
      transfer.state = 'cancelled';
      publishUploadProgress(transfer, true);
    }
  }
  return { ok: true };
};

/** Uploads under way or waiting to be used, for a renderer that just loaded. */
export const listRemoteAttachmentUploads = () =>
  [...hostUploadTransfers.values()].map((transfer) => ({
    machineId: transfer.machineId,
    machineName: machineDisplayName(transfer.machineId),
    path: transfer.localPath,
    size: transfer.size,
    sent: transfer.sent,
    state: transfer.state,
    route: transfer.route ?? null,
    ...(transfer.error ? { error: transfer.error } : {}),
  }));

export const runRemoteTurn = async ({
  machineId,
  threadId,
  projectId,
  prompt,
  context,
  attachments,
  modelId,
  accessMode,
  reasoningEffort,
  codexServiceTier,
  claudeContextWindow,
  spawnedBy,
  fromAgent,
  turnKey,
} = {}) => {
  try {
    const targetMachineId = String(machineId ?? '');
    const requestedAccessMode = sanitizeAccessMode(accessMode);
    const requestedReasoningEffort = sanitizeReasoningEffort(reasoningEffort);
    const requestedCodexServiceTier = sanitizeCodexServiceTier(codexServiceTier);
    const requestedClaudeContextWindow = sanitizeClaudeContextWindow(claudeContextWindow);
    // The turn's files go first (often already there: the prompt box started
    // them); the turn names them by upload id.
    const uploaded = (await uploadAttachmentsToHost(targetMachineId, attachments)).map(
      ({ uploadId, hostPath, transfer, attachment }) => ({
        uploadId,
        hostPath,
        transfer,
        localPath: String(attachment.path),
        name: String(attachment?.name ?? ''),
        ...(attachment?.snapshot ? { snapshot: attachment.snapshot } : {}),
      })
    );
    let response;
    try {
      response = await clientRequest(
        targetMachineId,
        {
          t: 'runTurn',
          ...(threadId ? { threadId: String(threadId) } : {}),
          ...(projectId ? { projectId: String(projectId) } : {}),
          ...(modelId ? { modelId: String(modelId) } : {}),
          ...(requestedAccessMode ? { accessMode: requestedAccessMode } : {}),
          ...(requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : {}),
          ...(requestedCodexServiceTier ? { codexServiceTier: requestedCodexServiceTier } : {}),
          ...(requestedClaudeContextWindow
            ? { claudeContextWindow: requestedClaudeContextWindow }
            : {}),
          ...(uploaded.length > 0
            ? {
                attachments: uploaded.map(({ uploadId, name, snapshot }) => ({
                  uploadId,
                  name,
                  ...(snapshot ? { snapshot } : {}),
                })),
              }
            : {}),
          prompt: String(prompt ?? ''),
          ...(typeof context === 'string' && context.trim() ? { context: context.slice(0, MAX_TURN_CONTEXT_CHARS) } : {}),
          ...(!threadId && typeof spawnedBy?.threadId === 'string' && spawnedBy.threadId
            ? { spawnedBy: { threadId: spawnedBy.threadId } }
            : {}),
          // An agent here sent the turn (machine_run_agent), not the user.
          ...(fromAgent === true ? { fromAgent: true } : {}),
        },
        (Number.isFinite(deps?.runTurnTimeoutMs) ? Math.max(1, deps.runTurnTimeoutMs) : RUN_TURN_TIMEOUT_MS) +
          (Number.isFinite(deps?.clientResponseGraceMs)
            ? Math.max(0, deps.clientResponseGraceMs)
            : CLIENT_RESPONSE_GRACE_MS),
        {
          extendOnClaim: true,
          // The host made (or found) the turn's thread and is starting it: tell
          // the renderer its id now, so the turn streams here while it starts.
          onClaimed:
            typeof turnKey === 'string' && turnKey
              ? (hostThreadId) =>
                  deps.broadcast('remote:event', {
                    machineId: targetMachineId,
                    kind: 'turnClaimed',
                    payload: { turnKey, threadId: hostThreadId },
                  })
              : undefined,
        }
      );
    } catch (error) {
      settleHostUploads(uploaded, { ok: false, error: error?.message });
      throw error;
    }
    settleHostUploads(uploaded, { ok: response.ok === true, error: response.error });
    return {
      ok: response.ok === true,
      threadId: typeof response.threadId === 'string' ? response.threadId : undefined,
      // Where each attachment landed on the host, so the controller's mirror
      // can show its own copy.
      ...(uploaded.length > 0
        ? {
            attachments: uploaded
              .filter((item) => item.hostPath)
              .map(({ hostPath, localPath }) => ({ hostPath, localPath })),
          }
        : {}),
      error: response.ok ? undefined : (response.error ?? 'The remote turn could not start.'),
    };
  } catch (error) {
    return clientErrorResult(error);
  }
};

/**
 * A copy of one of a paired host's attachments (shown in this machine's
 * mirror of its thread), kept in this machine's attachment cache. Reused when
 * already fetched.
 */
export const fetchRemoteAttachment = async ({ machineId, path: hostPath } = {}) => {
  try {
    const targetMachineId = String(machineId ?? '');
    const requestedPath = String(hostPath ?? '');
    if (typeof deps?.getRemoteAttachmentCacheDir !== 'function') {
      return { ok: false, error: 'Attachments from other machines are unavailable.' };
    }
    const directory = path.join(
      deps.getRemoteAttachmentCacheDir(),
      crypto.createHash('sha256').update(targetMachineId).digest('hex').slice(0, 16)
    );
    const localPath = path.join(
      directory,
      `${crypto.createHash('sha256').update(requestedPath).digest('hex').slice(0, 16)}-${sanitizeAttachmentName(path.basename(requestedPath))}`
    );
    try {
      await fs.access(localPath);
      return { ok: true, path: localPath };
    } catch {}
    // Written to disk as it arrives (never held whole in memory), under a
    // temporary name until complete.
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${localPath}.${crypto.randomUUID()}.part`;
    const handle = await fs.open(temporary, 'w');
    let complete = false;
    try {
      let offset = 0;
      let size = null;
      for (;;) {
        const response = await clientRequest(targetMachineId, { t: 'attachmentRead', path: requestedPath, offset });
        if (!response.ok) return { ok: false, error: response.error ?? 'Could not fetch the attachment.' };
        if (!Number.isSafeInteger(response.size) || response.size < 0) {
          throw new Error('The host sent an invalid attachment.');
        }
        // The mirror shows a large file of that machine by name only.
        if (response.size > MAX_MIRRORED_ATTACHMENT_BYTES) {
          return { ok: false, tooLarge: true, error: 'This attachment is too large to copy here.' };
        }
        if (size === null) size = response.size;
        if (response.size !== size || response.offset !== offset) throw new Error('The host sent an invalid attachment.');
        const chunk = Buffer.from(String(response.data ?? ''), 'base64');
        if (chunk.length > ATTACHMENT_CHUNK_BYTES || offset + chunk.length > size) {
          throw new Error('The host sent an invalid attachment.');
        }
        if (chunk.length > 0) await writeFully(handle, chunk, offset);
        offset += chunk.length;
        if (response.nextOffset === null) break;
        // Bounded by the size the host announced: a host cannot keep a fetch
        // going past it.
        if (response.nextOffset !== offset || chunk.length === 0 || offset >= size) {
          throw new Error('The host sent an invalid attachment.');
        }
      }
      if (offset !== size) throw new Error('The host sent an incomplete attachment.');
      await handle.close();
      await fs.rename(temporary, localPath);
      complete = true;
    } finally {
      if (!complete) {
        await handle.close().catch(() => {});
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    }
    return { ok: true, path: localPath };
  } catch (error) {
    return clientErrorResult(error);
  }
};

/** Name the host threads this machine shows, so their streams come through. */
export const followRemoteThreads = async ({ machineId, threadIds } = {}) => {
  try {
    const response = await clientRequest(String(machineId ?? ''), {
      t: 'follow',
      threadIds: (Array.isArray(threadIds) ? threadIds : []).slice(0, 64).map(String),
    });
    return { ok: response.ok === true };
  } catch (error) {
    return clientErrorResult(error);
  }
};

const unsupportedMessage = (response, what) =>
  response.error === 'Unsupported request.' ? `That machine cannot ${what} yet. Update Durango Code on it.` : null;

/** The questions and approvals a host thread's agent is waiting on. */
export const listRemoteQuestions = async ({ machineId, threadId } = {}) => {
  try {
    const response = await clientRequest(String(machineId ?? ''), { t: 'questions', threadId: String(threadId ?? '') });
    if (!response.ok) {
      return { ok: false, error: unsupportedMessage(response, 'share agent questions') ?? response.error ?? 'Could not read the questions.' };
    }
    return { ok: true, questions: Array.isArray(response.questions) ? response.questions : [] };
  } catch (error) {
    return clientErrorResult(error);
  }
};

/** Answer one of them there. */
export const answerRemoteQuestion = async ({ machineId, threadId, runId, requestId, answers } = {}) => {
  try {
    const response = await clientRequest(
      String(machineId ?? ''),
      { t: 'answerQuestion', threadId: String(threadId ?? ''), runId: String(runId ?? ''), requestId, answers },
      (Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS) +
        (Number.isFinite(deps?.clientResponseGraceMs) ? Math.max(0, deps.clientResponseGraceMs) : CLIENT_RESPONSE_GRACE_MS),
      { extendOnClaim: true }
    );
    if (!response.ok) {
      return { ok: false, error: unsupportedMessage(response, 'take answers') ?? response.error ?? 'The answer was not accepted.' };
    }
    return { ok: true };
  } catch (error) {
    return clientErrorResult(error);
  }
};

/**
 * Done, Reply (with files), Dismiss or Watch on an action a host thread asked
 * the user for (request_user_action).
 */
export const remoteUserAction = async ({ machineId, threadId, actionId, op, reply, attachments, watching, secretAnswer, answeredBy } = {}) => {
  try {
    const targetMachineId = String(machineId ?? '');
    const uploaded =
      op === 'reply'
        ? (await uploadAttachmentsToHost(targetMachineId, attachments)).map(({ uploadId, transfer, attachment }) => ({
            uploadId,
            transfer,
            name: String(attachment?.name ?? ''),
          }))
        : [];
    let response;
    try {
      response = await clientRequest(
        targetMachineId,
        {
          t: 'userAction',
          threadId: String(threadId ?? ''),
          actionId: String(actionId ?? ''),
          op,
          ...(op === 'reply'
            ? { reply: String(reply ?? ''), attachments: uploaded.map(({ uploadId, name }) => ({ uploadId, name })) }
            : {}),
          ...(op === 'watch' ? { watching: watching === true } : {}),
          ...(op === 'secret' ? { secretAnswer } : {}),
          ...(typeof answeredBy?.botName === 'string' && answeredBy.botName ? { answeredBy: { botName: answeredBy.botName.slice(0, 80) } } : {}),
        },
        (Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS) +
          (Number.isFinite(deps?.clientResponseGraceMs) ? Math.max(0, deps.clientResponseGraceMs) : CLIENT_RESPONSE_GRACE_MS),
        { extendOnClaim: true }
      );
    } catch (error) {
      settleHostUploads(uploaded, { ok: false, error: error?.message });
      throw error;
    }
    settleHostUploads(uploaded, { ok: response.ok === true, error: response.error });
    if (!response.ok) {
      return { ok: false, error: unsupportedMessage(response, 'take user action answers') ?? response.error ?? 'That machine did not take it.' };
    }
    return { ok: true };
  } catch (error) {
    return clientErrorResult(error);
  }
};

/** The branch (and Durango workspace) a host's thread works in. */
export const fetchRemoteThreadGit = async ({ machineId, threadId } = {}) => {
  try {
    const response = await clientRequest(String(machineId ?? ''), { t: 'threadGit', threadId: String(threadId ?? '') });
    if (!response.ok) {
      return {
        ok: false,
        error:
          response.error === 'Unsupported request.'
            ? 'That machine cannot report branches yet. Update Durango Code on it.'
            : (response.error ?? 'Could not read the branch.'),
      };
    }
    return {
      ok: true,
      branch: typeof response.branch === 'string' ? response.branch.slice(0, 300) : null,
      detachedHead: typeof response.detachedHead === 'string' ? response.detachedHead.slice(0, 64) : null,
      workspaceName: typeof response.workspaceName === 'string' ? response.workspaceName.slice(0, 200) : null,
      changeId: typeof response.changeId === 'string' ? response.changeId.slice(0, 100) : null,
      dirty: response.dirty === true,
    };
  } catch (error) {
    return clientErrorResult(error);
  }
};

/**
 * Asks a paired host to clone a Durango Source repository it doesn't have and
 * add it as a project (an existing checkout is reused) → { ok, projectId }.
 * The clone can take a while (a monorepo), hence the long timeout.
 */
export const checkoutRemoteSource = async ({ machineId, repoId, name } = {}) => {
  try {
    const response = await clientRequest(
      String(machineId ?? ''),
      { t: 'checkoutSource', repoId: String(repoId ?? ''), ...(name ? { name: String(name).slice(0, 200) } : {}) },
      SOURCE_CHECKOUT_TIMEOUT_MS
    );
    return response.ok
      ? { ok: true, projectId: typeof response.projectId === 'string' ? response.projectId : undefined }
      : { ok: false, error: response.error ?? 'The host could not check out the repository.' };
  } catch (error) {
    return clientErrorResult(error);
  }
};

/**
 * Send a message into a host thread's running turn ("Steer now"). ok = it is
 * in the turn; anything else stays the controller's to send later.
 */
export const steerRemoteTurn = async ({ machineId, threadId, prompt, attachments } = {}) => {
  try {
    const targetMachineId = String(machineId ?? '');
    const uploaded = (await uploadAttachmentsToHost(targetMachineId, attachments)).map(
      ({ uploadId, transfer, attachment }) => ({
        uploadId,
        transfer,
        name: String(attachment?.name ?? ''),
        ...(attachment?.snapshot ? { snapshot: attachment.snapshot } : {}),
      })
    );
    let response;
    try {
      response = await clientRequest(
        targetMachineId,
        {
          t: 'steerTurn',
          threadId: String(threadId ?? ''),
          prompt: String(prompt ?? ''),
          ...(uploaded.length > 0
            ? { attachments: uploaded.map(({ transfer: _transfer, ...attachment }) => attachment) }
            : {}),
        },
        (Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS) +
          (Number.isFinite(deps?.clientResponseGraceMs) ? Math.max(0, deps.clientResponseGraceMs) : CLIENT_RESPONSE_GRACE_MS),
        { extendOnClaim: true }
      );
    } catch (error) {
      settleHostUploads(uploaded, { ok: false, error: error?.message });
      throw error;
    }
    settleHostUploads(uploaded, { ok: response.ok === true, error: response.error });
    if (!response.ok) {
      return { ok: false, error: unsupportedMessage(response, 'take steering messages') ?? response.error ?? 'Steer failed.' };
    }
    return { ok: true };
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

/**
 * Settles, snoozes or pins (or undoes it for) a host thread, so that machine
 * files it like the mirror here: `state` as sanitizeThreadSidebarState.
 */
export const setRemoteThreadState = async ({ machineId, threadId, state } = {}) => {
  const sidebarState = sanitizeThreadSidebarState(state);
  if (!sidebarState) return { ok: false, error: 'Invalid thread state.' };
  try {
    const response = await clientRequest(
      String(machineId ?? ''),
      { t: 'threadState', threadId: String(threadId ?? ''), state: sidebarState },
      (Number.isFinite(deps?.requestTimeoutMs) ? Math.max(1, deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS) +
        (Number.isFinite(deps?.clientResponseGraceMs)
          ? Math.max(0, deps.clientResponseGraceMs)
          : CLIENT_RESPONSE_GRACE_MS),
      { extendOnClaim: true }
    );
    if (!response.ok) {
      return {
        ok: false,
        error: unsupportedMessage(response, 'settle or snooze threads from here') ?? response.error ?? 'That machine did not take it.',
      };
    }
    return { ok: true };
  } catch (error) {
    return clientErrorResult(error);
  }
};

/**
 * Runs a shell command on a paired host (its `exec` request) →
 * { ok, exitCode, stdout, stderr, … } (see remote-exec.js) or { ok: false, error }.
 * Aborting `signal` cancels the command there.
 */
export const execOnRemoteMachine = async ({ machineId, command, cwd, projectId, stdin, timeoutMs, signal } = {}) => {
  const targetMachineId = String(machineId ?? '');
  const execId = crypto.randomUUID();
  const limit = Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(1_000, Number(timeoutMs) || 120_000));
  if (signal?.aborted) return { ok: false, error: 'Cancelled before it started.' };
  // Cancel there only once the command was sent: clientRequest itself
  // refuses to send it after an abort.
  let dispatched = false;
  const onAbort = () => {
    if (dispatched) void clientRequest(targetMachineId, { t: 'execCancel', execId }).catch(() => {});
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const response = await clientRequest(
      targetMachineId,
      {
        t: 'exec',
        execId,
        command: String(command ?? ''),
        ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
        ...(typeof projectId === 'string' && projectId ? { projectId } : {}),
        ...(typeof stdin === 'string' ? { stdin } : {}),
        timeoutMs: limit,
      },
      // The host ends the command at its timeout and kills it within a few
      // seconds; the reply may take that long on top.
      limit + 15_000 + CLIENT_RESPONSE_GRACE_MS,
      {
        signal,
        onDispatch: () => {
          dispatched = true;
        },
      }
    );
    if (!response.ok) {
      return {
        ok: false,
        error:
          response.error === 'Unsupported request.'
            ? 'That machine cannot run commands for other machines yet. Update Durango Code on it.'
            : (response.error ?? 'The command could not run.'),
      };
    }
    return response;
  } catch (error) {
    return clientErrorResult(error);
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
};

/** A paired host's agent models (its `models` request) → { ok, models }. */
export const fetchRemoteModels = async ({ machineId } = {}) => {
  try {
    const response = await clientRequest(String(machineId ?? ''), { t: 'models' });
    return response.ok && Array.isArray(response.models)
      ? { ok: true, models: response.models }
      : { ok: false, error: response.error ?? 'Could not list the models there.' };
  } catch (error) {
    return clientErrorResult(error);
  }
};
