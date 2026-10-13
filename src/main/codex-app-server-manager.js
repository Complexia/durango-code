import { EventEmitter } from 'node:events';
import os from 'node:os';
import { Agent } from 'undici';

import { killAgentChild } from './run-registry.js';
import { spawnCodexServerProcess } from './codex-server-process.js';
import { loginShell, shellQuote } from './shell-env.js';

export const CODEX_APP_SERVER_IDLE_MS = 10 * 60 * 1000;
export const CODEX_APP_SERVER_MAX_CLIENTS = 100;
export const CODEX_APP_SERVER_MAX_CONNECT_FAILURES = 2;
export const CODEX_APP_SERVER_START_TIMEOUT_MS = 5000;
export const CODEX_APP_SERVER_CONNECT_TIMEOUT_MS = 3000;

const defaultSpawnServer = () => {
  const args = ['codex', 'app-server', '--listen', 'ws://127.0.0.1:0'];
  return spawnCodexServerProcess(loginShell, ['-lc', args.map(shellQuote).join(' ')], {
    cwd: os.homedir(),
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
};

// A WebSocket connection shaped like the ChildProcess surface the existing
// Codex driver consumes. Closing this object disconnects only one run; the
// shared app-server process stays alive for other turns.
export class CodexAppServerClient extends EventEmitter {
  constructor(socket, { abortTransport = () => socket.terminate?.() } = {}) {
    super();
    this.socket = socket;
    this.abortTransport = abortTransport;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this.signalCode = null;
    this.pid = null;
    this.closed = false;
    this.requestedSignal = null;
    this.stdin = {
      write: (data) => {
        if (this.closed || this.socket.readyState !== 1) {
          throw new Error('Codex app-server connection is closed.');
        }
        this.socket.send(String(data));
        return true;
      },
      end: () => this.kill('SIGTERM'),
    };

    socket.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data ?? '');
      this.stdout.emit('data', Buffer.from(`${data}\n`));
    });
    socket.addEventListener('error', () => {
      this.stderr.emit('data', Buffer.from('Codex app-server connection failed.'));
    });
    socket.addEventListener('close', (event) => {
      this.finish(this.requestedSignal ? null : event.code === 1000 ? 0 : 1);
    });
  }

  finish(exitCode = null) {
    if (this.closed) return;
    this.closed = true;
    this.signalCode = this.requestedSignal;
    this.exitCode = exitCode;
    queueMicrotask(() => {
      this.emit('exit', this.exitCode, this.signalCode);
      this.emit('close', this.exitCode, this.signalCode);
    });
  }

  kill(signal = 'SIGTERM') {
    if (this.closed) return false;
    this.requestedSignal = signal;
    if (signal === 'SIGKILL') {
      try {
        this.abortTransport();
      } catch {}
      this.finish(null);
      return true;
    }
    try {
      this.socket.close(1000, 'Durango Code run ended');
    } catch {
      try {
        this.abortTransport();
      } catch {}
      this.finish(null);
    }
    return true;
  }
}

const defaultConnectClient = (endpoint, timeoutMs) =>
  new Promise((resolve, reject) => {
    const dispatcher = new Agent();
    let dispatcherDestroyed = false;
    const abortTransport = () => {
      if (dispatcherDestroyed) return;
      dispatcherDestroyed = true;
      void dispatcher.destroy().catch(() => {});
    };
    let socket;
    try {
      socket = new WebSocket(endpoint, { dispatcher });
    } catch (error) {
      abortTransport();
      reject(error);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {}
      abortTransport();
      reject(new Error('Codex app-server connection timed out.'));
    }, timeoutMs);
    const cleanup = () => clearTimeout(timer);
    socket.addEventListener(
      'open',
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.addEventListener('close', abortTransport, { once: true });
        resolve(new CodexAppServerClient(socket, { abortTransport }));
      },
      { once: true }
    );
    socket.addEventListener(
      'error',
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        abortTransport();
        reject(new Error('Codex app-server connection failed.'));
      },
      { once: true }
    );
  });

// Owns one warm Codex app-server for the Orion main process. Each run gets a
// separate WebSocket connection, so request ids, subscriptions, stop behavior,
// and activeAgentRuns ownership remain isolated. The server is recycled while
// idle to bound loaded-thread state and pick up CLI updates without making
// process count grow with the number of Orion threads.
export const createCodexAppServerManager = ({
  spawnServer = defaultSpawnServer,
  connectClient = defaultConnectClient,
  terminateServer = killAgentChild,
  startupTimeoutMs = CODEX_APP_SERVER_START_TIMEOUT_MS,
  connectTimeoutMs = CODEX_APP_SERVER_CONNECT_TIMEOUT_MS,
  idleTimeoutMs = CODEX_APP_SERVER_IDLE_MS,
  maxClients = CODEX_APP_SERVER_MAX_CLIENTS,
  maxConnectFailures = CODEX_APP_SERVER_MAX_CONNECT_FAILURES,
  logger = console,
} = {}) => {
  let server = null;
  let startPromise = null;
  let stopPromise = null;
  let idleTimer = null;
  let permanentlyStopped = false;
  let activeClients = 0;
  let clientsSinceStart = 0;

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const stop = ({ permanent = false } = {}) => {
    if (permanent) permanentlyStopped = true;
    clearIdleTimer();
    if (stopPromise) return stopPromise;

    stopPromise = (async () => {
      if (startPromise) await startPromise.catch(() => null);
      const current = server;
      server = null;
      clientsSinceStart = 0;
      if (current?.child) await terminateServer(current.child);
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  };

  const scheduleIdleRecycle = () => {
    clearIdleTimer();
    if (permanentlyStopped || activeClients !== 0 || !server) return;
    const delay = server.unusable || clientsSinceStart >= maxClients ? 0 : idleTimeoutMs;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (activeClients === 0) void stop();
    }, Math.max(0, delay));
    idleTimer.unref?.();
  };

  const ensureStarted = async () => {
    if (permanentlyStopped) return null;
    // A recycle owns the current server until termination completes. Re-enter
    // startup afterwards so every waiter observes (and shares) any startup
    // another waiter already began while this one was suspended.
    if (stopPromise) {
      await stopPromise;
      return ensureStarted();
    }
    if (startPromise) return startPromise;
    if (server?.unusable) {
      if (activeClients !== 0) return null;
      await stop();
      return ensureStarted();
    }
    if (
      server?.endpoint &&
      server.child &&
      server.child.exitCode === null &&
      server.child.signalCode === null
    ) {
      return server;
    }
    startPromise = new Promise((resolve) => {
      let child;
      try {
        child = spawnServer();
      } catch (error) {
        logger.warn?.('codex app-server: persistent startup failed', error);
        resolve(null);
        return;
      }

      const current = {
        child,
        endpoint: null,
        stderr: '',
        connectFailures: 0,
        unusable: false,
      };
      server = current;
      // WebSocket mode uses stderr for discovery; discard any shell/stdout
      // chatter so the supervised pipe cannot fill and stall the server.
      child.stdout?.resume?.();
      clientsSinceStart = 0;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const fail = (detail) => {
        if (server === current) server = null;
        const message = detail || current.stderr.trim();
        logger.warn?.(
          `codex app-server: persistent startup unavailable${message ? `: ${message}` : ''}`
        );
        void terminateServer(child);
        finish(null);
      };
      const timer = setTimeout(
        () => fail('Codex app-server startup timed out.'),
        startupTimeoutMs
      );

      child.stderr?.on?.('data', (data) => {
        const text = data.toString();
        current.stderr = `${current.stderr}${text}`.slice(-4000);
        const endpoint = current.stderr.match(/listening on:\s*(ws:\/\/\S+)/)?.[1];
        if (!endpoint || current.endpoint) return;
        current.endpoint = endpoint;
        finish(current);
      });
      child.on?.('error', (error) => fail(error?.message));
      child.on?.('exit', (code, signal) => {
        if (server === current) {
          server = null;
          clientsSinceStart = 0;
        }
        if (!settled) fail(`Codex app-server exited (${code ?? signal ?? 'unknown'}).`);
      });
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  };

  const acquire = async () => {
    clearIdleTimer();
    const current = await ensureStarted();
    if (!current || permanentlyStopped || server !== current || !current.endpoint) {
      return { persistent: false, child: null, release: () => {} };
    }

    let child;
    try {
      child = await connectClient(current.endpoint, connectTimeoutMs);
    } catch (error) {
      logger.warn?.('codex app-server: persistent connection unavailable', error);
      let recycleCurrent = false;
      if (server === current) {
        current.connectFailures += 1;
        if (current.connectFailures >= Math.max(1, maxConnectFailures)) {
          current.unusable = true;
        }
        recycleCurrent = current.unusable;
      }
      if (recycleCurrent && activeClients === 0) {
        await stop();
      } else if (server === current) {
        scheduleIdleRecycle();
      }
      return { persistent: false, child: null, release: () => {} };
    }
    if (permanentlyStopped || server !== current) {
      child.kill?.('SIGTERM');
      return { persistent: false, child: null, release: () => {} };
    }
    current.connectFailures = 0;

    activeClients += 1;
    clientsSinceStart += 1;
    let released = false;
    return {
      persistent: true,
      child,
      endpoint: current.endpoint,
      release: () => {
        if (released) return;
        released = true;
        child.kill?.('SIGTERM');
        activeClients = Math.max(0, activeClients - 1);
        scheduleIdleRecycle();
      },
    };
  };

  const snapshot = () => ({
    permanentlyStopped,
    running: Boolean(server),
    starting: Boolean(startPromise),
    activeClients,
    clientsSinceStart,
    endpoint: server?.endpoint ?? null,
  });

  return {
    acquire,
    recycle: () => stop(),
    shutdown: () => stop({ permanent: true }),
    snapshot,
  };
};

export const codexAppServerManager = createCodexAppServerManager();
