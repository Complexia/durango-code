import net from 'node:net';
import { Agent } from 'undici';

// Transports for the remote-control wire protocol.
//
// `SecureChannel` (remote-crypto.js) speaks a byte stream and nothing else:
// 4-byte length-prefixed frames, encrypted end to end once the handshake
// completes. This module supplies the pipes that carry those bytes, all
// exposing the same shape:
//
//   { onOpen(cb), onData(cb), onClose(cb), write(buffer), close(), destroy(error?) }
//
// Two families exist:
//
// - TCP (`createTcpTransport`, `wrapTcpSocket`) — the original, unchanged
//   direct LAN/VPN path.
// - Relay (`createRelayTransport`, `createRelayListener`) — WebSockets to an
//   Orion Cloud relay that splices a controller's socket to a host's socket.
//
// The relay is an UNTRUSTED byte pipe. Nothing here interprets the payload,
// trusts the relay's identity claims, or lets the relay influence the
// handshake: it can drop or delay traffic, and that is all. Every guarantee
// the direct path has (mutual authentication against the paired device
// secret, forward secrecy, replay/tamper rejection, the Orion Cloud account
// proof) is produced above this layer and rides over the relay unchanged.
//
// WebSocket implementation: the main process runs Electron 42 (Node 24), whose
// global `WebSocket` is stable. Undici supplies per-socket dispatchers used to
// set parser-level payload caps and to abort the underlying connection when a
// relay ignores the WebSocket closing handshake. Only client sockets are ever
// needed here — the app never accepts a WebSocket.

const CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 3000;
const RELAY_OPEN_TIMEOUT_MS = 15_000;
const RELAY_HEALTHY_CONNECTION_MS = 30_000;
// The relay pings the control socket every 30s. A socket that goes this long
// without ANY inbound frame is half-open (sleep/wake, NAT rebind, network
// change) — the OS never reports a close for those, so without this watchdog
// the host believes it is online forever while the relay has long marked it
// offline. 2.5 ping intervals tolerates one lost ping outright.
const RELAY_CONTROL_IDLE_TIMEOUT_MS = 75_000;
// Control messages are tiny (`ping` or a bounded stream id). Enforce the cap
// in the WebSocket parser, before a hostile relay can materialize an enormous
// string in JavaScript. The explicit length check below is defense in depth and
// keeps injected/test WebSocket implementations bound by the same contract.
const RELAY_CONTROL_MAX_PAYLOAD_BYTES = 4096;
// SecureChannel writes one complete length-prefixed frame per WebSocket
// message. Its authenticated frame ceiling is 8 MiB, plus the 4-byte length
// prefix. Enforce the same ceiling in Undici's parser so an untrusted relay
// cannot make JavaScript materialize an arbitrarily large event.data first.
const RELAY_DATA_MAX_PAYLOAD_BYTES = 4 + 8 * 1024 * 1024;
// Reconnect backoff for the host control socket. Capped, with full jitter over
// the lower half of each step so a relay restart does not produce a synchronized
// stampede from every desktop that was connected to it.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
// A hostile or broken relay must not be able to make this process open
// unbounded sockets by spamming `dial`.
const MAX_CONCURRENT_STREAMS = 12;
// TCP and WebSocket implementations both buffer writes when a peer stops
// reading. A verbose agent turn must not let that native queue grow without
// bound, so every data transport closes once it reaches this ceiling.
export const MAX_PENDING_WRITE_BYTES = 16 * 1024 * 1024;

const slowPeerError = () => new Error('The remote connection is not reading data.');

// ---------------------------------------------------------------------------
// TCP

/**
 * Adapt an existing (usually accepted) net.Socket. Used for inbound
 * connections on the host side, and by SecureChannel when it is handed a raw
 * socket.
 */
export const wrapTcpSocket = (socket, { maxPendingWriteBytes = MAX_PENDING_WRITE_BYTES } = {}) => {
  socket.setNoDelay(true);
  return {
    kind: 'tcp',
    socket,
    onOpen(handler) {
      if (socket.connecting) socket.on('connect', handler);
      else queueMicrotask(handler);
    },
    onData(handler) {
      socket.on('data', handler);
    },
    onClose(handler) {
      socket.on('error', handler);
      socket.on('close', () => handler());
    },
    write(buffer) {
      if (socket.destroyed) return false;
      const queuedBytes = Number.isFinite(socket.writableLength) ? socket.writableLength : 0;
      if (buffer.length > maxPendingWriteBytes - queuedBytes) {
        socket.destroy(slowPeerError());
        return false;
      }
      return socket.write(buffer);
    },
    close() {
      socket.end();
      // A peer that never acks the FIN must not pin the socket open.
      socket.setTimeout(CLOSE_GRACE_MS, () => socket.destroy());
    },
    destroy() {
      socket.destroy();
    },
  };
};

/** Dial a host directly over TCP — the LAN/VPN path, byte-for-byte as before. */
export const createTcpTransport = ({ host, port, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) => {
  const socket = net.connect({ host, port, timeout: connectTimeoutMs });
  socket.on('timeout', () => {
    socket.destroy(new Error('Connection timed out.'));
  });
  const transport = wrapTcpSocket(socket);
  return {
    ...transport,
    onOpen(handler) {
      socket.on('connect', () => {
        // The timeout above guards the connect phase only; an established
        // session may legitimately sit idle for hours.
        socket.setTimeout(0);
        handler();
      });
    },
  };
};

// ---------------------------------------------------------------------------
// Relay URLs

/**
 * Build a relay endpoint URL. Accepts ws(s):// or http(s):// bases (the latter
 * are upgraded), and preserves any path prefix on the base so the relay can be
 * mounted behind a gateway.
 */
export const relayEndpoint = (relayUrl, endpointPath, params = {}) => {
  const url = new URL(String(relayUrl ?? ''));
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('The relay address must be a ws:// or wss:// URL.');
  }
  url.hash = '';
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${endpointPath}`;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
};

// The relay's documented close codes. Anything else is reported verbatim so a
// deployment problem is visible instead of showing up as a generic failure.
const closeCodeMessage = (event) => {
  switch (event?.code) {
    case 4401:
      return 'The relay rejected this machine’s ticket.';
    case 4404:
      return 'That machine is not connected to the relay.';
    case 4408:
      return 'That machine did not answer through the relay in time.';
    case 1000:
    case 1005:
      return null;
    default:
      return event?.reason ? `The relay closed the connection: ${event.reason}` : 'The relay closed the connection.';
  }
};

// ---------------------------------------------------------------------------
// Relay data sockets

/**
 * One relay data socket as a transport. Binary WebSocket messages are opaque
 * chunks of the same byte stream TCP would carry — the relay is explicitly
 * allowed to split or coalesce them, and SecureChannel already reassembles
 * partial reads.
 *
 * Events that arrive before the caller installs its handlers are queued rather
 * than dropped, so attaching a SecureChannel is never a race.
 */
const createWebSocketTransport = (
  endpoint,
  {
    openTimeoutMs = RELAY_OPEN_TIMEOUT_MS,
    closeGraceMs = CLOSE_GRACE_MS,
    maxPendingWriteBytes = MAX_PENDING_WRITE_BYTES,
  } = {}
) => {
  const dispatcher = new Agent({
    webSocket: {
      maxFragments: 16,
      maxPayloadSize: RELAY_DATA_MAX_PAYLOAD_BYTES,
    },
  });
  let dispatcherDestroyed = false;
  const destroyDispatcher = () => {
    if (dispatcherDestroyed) return;
    dispatcherDestroyed = true;
    void dispatcher.destroy().catch(() => {});
  };
  let socket = null;
  let socketError = null;
  try {
    socket = new WebSocket(endpoint, { dispatcher });
    socket.binaryType = 'arraybuffer';
  } catch (error) {
    socketError = error instanceof Error ? error : new Error(String(error));
    destroyDispatcher();
  }

  let opened = false;
  // A constructor that threw is already terminal; the queued close below is
  // what reports it, so nothing further may fire a second close.
  let finished = Boolean(socketError);
  let openHandler = null;
  let dataHandler = null;
  let closeHandler = null;
  const dataQueue = [];
  const writeQueue = [];
  let writeQueueBytes = 0;
  let queuedClose = { pending: Boolean(socketError), error: socketError };
  let openTimer = null;
  let closeTimer = null;

  const clearTimers = () => {
    if (openTimer) clearTimeout(openTimer);
    if (closeTimer) clearTimeout(closeTimer);
    openTimer = null;
    closeTimer = null;
  };

  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimers();
    // Each dispatcher owns exactly this data socket. Once the wrapper is
    // terminal there is no connection pool worth retaining.
    destroyDispatcher();
    if (closeHandler) closeHandler(error ?? null);
    else queuedClose = { pending: true, error: error ?? null };
  };

  const requestClose = () => {
    if (!socket) return;
    try {
      if (socket.readyState === 0 || socket.readyState === 1) socket.close();
    } catch {}
  };

  const abortSocket = (error = null) => {
    // WebSocket.close() only starts the closing handshake. Destroy the owned
    // dispatcher as well so CONNECTING/CLOSING native sockets cannot outlive
    // logical stream accounting when the relay refuses to cooperate.
    destroyDispatcher();
    // Mark the wrapper terminal before requesting close because injected/test
    // implementations may emit `close` synchronously and otherwise erase the
    // more useful teardown error.
    finish(error);
    requestClose();
  };

  const sendBuffer = (buffer) => {
    const queuedBytes = Number.isFinite(socket?.bufferedAmount) ? socket.bufferedAmount : 0;
    if (buffer.length > maxPendingWriteBytes - queuedBytes) {
      abortSocket(slowPeerError());
      return false;
    }
    try {
      socket.send(buffer);
      return true;
    } catch (error) {
      abortSocket(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  };

  if (socket) {
    openTimer = setTimeout(() => {
      openTimer = null;
      if (opened || finished) return;
      abortSocket(new Error('The relay did not accept the connection in time.'));
    }, openTimeoutMs);
    openTimer.unref?.();

    socket.addEventListener('open', () => {
      opened = true;
      if (openTimer) clearTimeout(openTimer);
      openTimer = null;
      for (const buffer of writeQueue.splice(0)) {
        writeQueueBytes -= buffer.length;
        if (!sendBuffer(buffer)) return;
      }
      openHandler?.();
    });

    socket.addEventListener('message', (event) => {
      if (finished) return;
      if (typeof event.data === 'string') {
        // Data sockets carry binary frames only. A relay that injects text is
        // not speaking the contract; refuse rather than guess.
        abortSocket(new Error('The relay sent an unexpected control frame.'));
        return;
      }
      const chunk = Buffer.from(
        event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(event.data ?? [])
      );
      if (chunk.length === 0) return;
      if (dataHandler) dataHandler(chunk);
      else dataQueue.push(chunk);
    });

    socket.addEventListener('error', () => {
      // The WebSocket error event carries no useful detail by design; `close`
      // follows with the code.
      if (!opened) {
        abortSocket(new Error('Could not reach the Durango Cloud relay.'));
      }
    });

    socket.addEventListener('close', (event) => {
      const message = closeCodeMessage(event);
      finish(message ? new Error(message) : null);
    });
  }

  return {
    kind: 'relay',
    socket: null,
    onOpen(handler) {
      openHandler = handler;
      if (opened) queueMicrotask(() => handler());
    },
    onData(handler) {
      dataHandler = handler;
      while (dataQueue.length > 0) handler(dataQueue.shift());
    },
    onClose(handler) {
      closeHandler = handler;
      if (queuedClose.pending) {
        const { error } = queuedClose;
        queuedClose = { pending: false, error: null };
        queueMicrotask(() => handler(error ?? null));
      }
    },
    write(buffer) {
      if (finished || !socket) return false;
      if (!opened) {
        if (buffer.length > maxPendingWriteBytes - writeQueueBytes) {
          abortSocket(slowPeerError());
          return false;
        }
        writeQueue.push(Buffer.from(buffer));
        writeQueueBytes += buffer.length;
        return true;
      }
      return sendBuffer(buffer);
    },
    close() {
      if (finished) return;
      requestClose();
      if (finished) return;
      // A peer that never completes the closing handshake must not pin the
      // socket open — same guard the TCP transport applies to a missing FIN.
      if (!closeTimer) {
        closeTimer = setTimeout(() => {
          closeTimer = null;
          if (finished) return;
          abortSocket();
        }, closeGraceMs);
        closeTimer.unref?.();
      }
    },
    destroy(error) {
      abortSocket(error ?? null);
    },
  };
};

/**
 * Controller side: reach a host by machine id through the relay.
 * `ticket` is a short-lived, single-socket relay ticket — never an account
 * credential, and never shown to the peer.
 */
export const createRelayTransport = ({
  relayUrl,
  ticket,
  machineId,
  openTimeoutMs,
  closeGraceMs,
  maxPendingWriteBytes,
} = {}) =>
  createWebSocketTransport(relayEndpoint(relayUrl, '/v1/connect', { ticket, machine: machineId }), {
    openTimeoutMs,
    closeGraceMs,
    maxPendingWriteBytes,
  });

// ---------------------------------------------------------------------------
// Relay listener (host side)

/**
 * Host side: hold the relay's control socket and dial back a data socket for
 * every `dial` the relay asks for. The returned transports are handed to
 * `onStream` and must go through exactly the same inbound handshake path as an
 * accepted TCP socket.
 *
 * `getTicket(role)` mints a fresh relay ticket per socket. Reconnects use
 * capped exponential backoff with jitter, and `stop()` is terminal.
 */
export const createRelayListener = ({
  relayUrl,
  getTicket,
  onStream,
  onStatus,
  openTimeoutMs = RELAY_OPEN_TIMEOUT_MS,
  healthyConnectionMs = RELAY_HEALTHY_CONNECTION_MS,
  idleTimeoutMs = RELAY_CONTROL_IDLE_TIMEOUT_MS,
  reconnectBaseMs = RECONNECT_BASE_MS,
  reconnectMaxMs = RECONNECT_MAX_MS,
  reconnectRandom = Math.random,
} = {}) => {
  let stopped = false;
  let control = null;
  let attempt = 0;
  let reconnectTimer = null;
  let online = false;
  let lastError = null;
  const streams = new Set();
  let reservedStreamSlots = 0;
  const ticketControllers = new Set();
  let controlDispatcher = null;
  let controlHealthyTimer = null;
  let controlIdleTimer = null;

  const clearControlHealthyTimer = (socket = null) => {
    if (!controlHealthyTimer || (socket && controlHealthyTimer.socket !== socket)) return;
    clearTimeout(controlHealthyTimer.timer);
    controlHealthyTimer = null;
  };

  const clearControlIdleTimer = (socket = null) => {
    if (!controlIdleTimer || (socket && controlIdleTimer.socket !== socket)) return;
    clearTimeout(controlIdleTimer.timer);
    controlIdleTimer = null;
  };

  // Liveness watchdog: the relay pings every 30s, so a control socket with no
  // inbound frames for idleTimeoutMs is half-open. `close` never fires for
  // those sockets — tear it down ourselves and let the backoff reconnect.
  const armControlIdleTimer = (socket) => {
    if (stopped || control !== socket) return;
    clearControlIdleTimer(socket);
    const timer = setTimeout(() => {
      if (stopped || control !== socket) return;
      controlIdleTimer = null;
      clearControlHealthyTimer(socket);
      const dispatcher = controlDispatcher;
      control = null;
      controlDispatcher = null;
      try {
        socket.close();
      } catch {}
      void dispatcher?.destroy().catch(() => {});
      publish(false, 'The relay connection went quiet; reconnecting.');
      scheduleReconnect();
    }, idleTimeoutMs);
    timer.unref?.();
    controlIdleTimer = { socket, timer };
  };

  const issueTicket = async (role) => {
    const controller = new AbortController();
    ticketControllers.add(controller);
    try {
      const issued = await getTicket(role, { signal: controller.signal });
      if (controller.signal.aborted || stopped) throw new Error('The relay ticket request was cancelled.');
      const ticket = typeof issued === 'string' ? issued : issued?.ticket;
      const ticketRelayUrl = typeof issued === 'string' ? relayUrl : issued?.relayUrl;
      if (!ticket || !ticketRelayUrl) throw new Error('The relay ticket did not include connection details.');
      return { ticket, relayUrl: ticketRelayUrl };
    } finally {
      ticketControllers.delete(controller);
    }
  };

  const publish = (nextOnline, error) => {
    if (online === nextOnline && lastError === error) return;
    online = nextOnline;
    lastError = error;
    onStatus?.({ online, error });
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer || control) return;
    const step = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** Math.min(attempt, 6));
    attempt += 1;
    const randomValue = reconnectRandom();
    const jitter = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0;
    const delay = step / 2 + jitter * (step / 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    reconnectTimer.unref?.();
  };

  const openStream = async (streamId) => {
    if (stopped) return;
    // Reserve before the first await. A hostile relay can deliver many `dial`
    // frames in one turn, while every ticket request is still pending; counting
    // only constructed transports would let all of them pass the cap.
    if (streams.size + reservedStreamSlots >= MAX_CONCURRENT_STREAMS) return;
    reservedStreamSlots += 1;
    let reservationHeld = true;
    const releaseReservation = () => {
      if (!reservationHeld) return;
      reservationHeld = false;
      reservedStreamSlots -= 1;
    };
    try {
      const issued = await issueTicket('host');
      if (stopped) return;
      const transport = createWebSocketTransport(
        relayEndpoint(issued.relayUrl, '/v1/stream', { ticket: issued.ticket, stream: streamId })
      );
      streams.add(transport);
      releaseReservation();
      transport.onClose(() => streams.delete(transport));
      transport.onOpen(() => {
        streams.delete(transport);
        if (stopped) {
          transport.destroy();
          return;
        }
        try {
          onStream?.(transport);
        } catch {
          transport.destroy();
        }
      });
    } catch {
      // Ticket and URL/transport failures both release the reserved slot in
      // `finally`, allowing later legitimate dials to proceed.
    } finally {
      releaseReservation();
    }
  };

  const rejectControlMessage = (socket, reason, code = 1008) => {
    if (control !== socket) return;
    clearControlHealthyTimer(socket);
    clearControlIdleTimer(socket);
    const dispatcher = controlDispatcher;
    control = null;
    controlDispatcher = null;
    try {
      socket.close(code, reason);
    } catch {}
    // This dispatcher owns exactly this control socket. Destroying it makes a
    // protocol violation terminal even if the relay ignores the close frame.
    void dispatcher?.destroy().catch(() => {});
    publish(false, reason);
    scheduleReconnect();
  };

  const handleControlMessage = (socket, data) => {
    if (typeof data !== 'string') {
      rejectControlMessage(socket, 'The relay sent a malformed control message.');
      return;
    }
    if (Buffer.byteLength(data, 'utf8') > RELAY_CONTROL_MAX_PAYLOAD_BYTES) {
      rejectControlMessage(socket, 'The relay control message was too large.', 1009);
      return;
    }
    let message = null;
    try {
      message = JSON.parse(data);
    } catch {
      rejectControlMessage(socket, 'The relay sent malformed control JSON.');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      rejectControlMessage(socket, 'The relay sent a malformed control message.');
      return;
    }
    if (message.t === 'ping') {
      try {
        socket.send(JSON.stringify({ t: 'pong' }));
      } catch {}
      return;
    }
    if (message.t === 'dial') {
      const streamId = String(message.streamId ?? '');
      if (!streamId || streamId.length > 128) {
        rejectControlMessage(socket, 'The relay sent an invalid stream request.');
        return;
      }
      void openStream(streamId);
      return;
    }
    rejectControlMessage(socket, 'The relay sent an unsupported control message.');
  };

  const connect = async () => {
    if (stopped || control) return;
    let issued;
    try {
      issued = await issueTicket('host');
    } catch (error) {
      if (stopped) return;
      publish(false, error?.message ?? String(error));
      scheduleReconnect();
      return;
    }
    if (stopped || control) return;
    const dispatcher = new Agent({
      webSocket: {
        maxFragments: 16,
        maxPayloadSize: RELAY_CONTROL_MAX_PAYLOAD_BYTES,
      },
    });
    let socket;
    try {
      socket = new WebSocket(relayEndpoint(issued.relayUrl, '/v1/host', { ticket: issued.ticket }), {
        dispatcher,
      });
    } catch (error) {
      void dispatcher.destroy().catch(() => {});
      publish(false, error?.message ?? String(error));
      scheduleReconnect();
      return;
    }
    control = socket;
    controlDispatcher = dispatcher;
    socket.binaryType = 'arraybuffer';
    let openTimer = setTimeout(() => {
      openTimer = null;
      // Clear only the connection attempt this timer owns. A stale timeout may
      // never close or replace a newer control socket.
      if (stopped || control !== socket || socket.readyState !== 0) return;
      control = null;
      if (controlDispatcher === dispatcher) controlDispatcher = null;
      try {
        socket.close();
      } catch {}
      void dispatcher.destroy().catch(() => {});
      publish(false, 'The relay did not accept the control connection in time.');
      scheduleReconnect();
    }, openTimeoutMs);
    openTimer.unref?.();
    socket.addEventListener('open', () => {
      if (openTimer) clearTimeout(openTimer);
      openTimer = null;
      if (stopped || control !== socket) {
        try {
          socket.close();
        } catch {}
        return;
      }
      const timer = setTimeout(() => {
        if (stopped || control !== socket) return;
        attempt = 0;
        if (controlHealthyTimer?.socket === socket) controlHealthyTimer = null;
      }, Math.max(1, healthyConnectionMs));
      timer.unref?.();
      controlHealthyTimer = { socket, timer };
      armControlIdleTimer(socket);
      publish(true, null);
    });
    socket.addEventListener('message', (event) => {
      armControlIdleTimer(socket);
      handleControlMessage(socket, event.data);
    });
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', (event) => {
      if (openTimer) clearTimeout(openTimer);
      openTimer = null;
      clearControlHealthyTimer(socket);
      clearControlIdleTimer(socket);
      void dispatcher.destroy().catch(() => {});
      if (control !== socket) return;
      control = null;
      if (controlDispatcher === dispatcher) controlDispatcher = null;
      publish(false, closeCodeMessage(event));
      scheduleReconnect();
    });
  };

  return {
    start() {
      if (stopped) return;
      void connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearControlHealthyTimer();
      clearControlIdleTimer();
      for (const controller of ticketControllers) controller.abort(new Error('Relay listener stopped.'));
      ticketControllers.clear();
      const socket = control;
      const dispatcher = controlDispatcher;
      control = null;
      controlDispatcher = null;
      if (socket) {
        try {
          socket.close();
        } catch {}
      }
      void dispatcher?.destroy().catch(() => {});
      for (const transport of [...streams]) transport.destroy();
      streams.clear();
      publish(false, null);
    },
    getStatus() {
      return { online, error: lastError };
    },
  };
};
