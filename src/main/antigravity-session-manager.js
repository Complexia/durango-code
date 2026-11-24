import { spawn } from 'node:child_process';
import { killAgentChild } from './run-registry.js';
import { loginShell, shellQuote } from './shell-env.js';

// Persistent per-thread `agy acp` process pool.
//
// `agy` is a large standalone binary (~200 MB); cold-starting it and running
// `session/load` on every turn wastes seconds and replays the whole history
// over stdio just to discard it. Keeping the live ACP process warm per thread
// lets follow-up turns skip initialize + session/load completely, switch
// model/mode in-session, and use graceful `session/cancel` on Stop.
//
// Each warm entry also owns its `orionMcp` bridge lease so the MCP connection
// registered at `session/new` / `session/resume` stays valid across turns, and
// recycles automatically after being idle or when the thread/app shuts down.

export const ANTIGRAVITY_SESSION_IDLE_MS = 10 * 60 * 1000;
export const MAX_IDLE_ANTIGRAVITY_SESSIONS = 3;

const defaultSpawnProcess = ({ commandArgs, cwd, env }) =>
  spawn(loginShell, ['-lc', commandArgs.map(shellQuote).join(' ')], {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...(env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

const signatureFor = ({ cwd, accessMode, commandArgs, mcpKey }) =>
  JSON.stringify([cwd || '', accessMode || '', commandArgs || [], mcpKey || '']);

export const createAntigravitySessionManager = ({
  spawnProcess = defaultSpawnProcess,
  terminateProcess = killAgentChild,
  idleTimeoutMs = ANTIGRAVITY_SESSION_IDLE_MS,
  maxIdleSessions = MAX_IDLE_ANTIGRAVITY_SESSIONS,
} = {}) => {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  let shuttingDown = false;

  const clearIdleTimer = (entry) => {
    if (!entry?.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  };

  const clearExitTimer = (entry) => {
    if (!entry?.exitFallbackTimer) return;
    clearTimeout(entry.exitFallbackTimer);
    entry.exitFallbackTimer = null;
  };

  const destroyEntry = async (entry) => {
    if (!entry || entry.destroyed) return;
    entry.destroyed = true;
    clearIdleTimer(entry);
    clearExitTimer(entry);
    if (sessions.get(entry.threadId) === entry) {
      sessions.delete(entry.threadId);
    }
    const mcp = entry.orionMcp;
    entry.orionMcp = null;
    try {
      mcp?.release?.();
    } catch {}
    if (entry.child) {
      await Promise.resolve(terminateProcess(entry.child, entry.threadId)).catch(() => {});
    }
  };

  const evictOverflowIdleSessions = () => {
    if (!(maxIdleSessions >= 0)) return;
    const idleEntries = [...sessions.values()]
      .filter((candidate) => !candidate.busy && !candidate.destroyed)
      .sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0));
    while (idleEntries.length > maxIdleSessions) {
      const oldest = idleEntries.shift();
      if (oldest) void destroyEntry(oldest);
    }
  };

  const scheduleIdleRecycle = (entry) => {
    clearIdleTimer(entry);
    if (shuttingDown || !entry || entry.destroyed || entry.busy) return;
    entry.idleSince = Date.now();
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (!entry.busy) void destroyEntry(entry);
    }, Math.max(0, idleTimeoutMs));
    entry.idleTimer.unref?.();
    evictOverflowIdleSessions();
  };

  const replyIdleRequest = (entry, parsed) => {
    if (parsed.id === undefined || !parsed.method) return;
    const payload =
      parsed.method === 'session/request_permission'
        ? { jsonrpc: '2.0', id: parsed.id, result: { outcome: { outcome: 'cancelled' } } }
        : parsed.method === 'elicitation/create'
          ? { jsonrpc: '2.0', id: parsed.id, result: { action: 'cancel' } }
          : { jsonrpc: '2.0', id: parsed.id, error: { code: -32601, message: 'Session idle' } };
    try {
      entry.child?.stdin?.write?.(`${JSON.stringify(payload)}\n`);
    } catch {}
  };

  const isAlive = (entry) =>
    Boolean(
      entry &&
        !entry.destroyed &&
        entry.child &&
        entry.child.exitCode === null &&
        entry.child.signalCode === null &&
        !entry.child.killed
    );

  /**
   * Acquire a warm `agy acp` process for `threadId`, or spawn a new one.
   *
   * If an idle warm process already exists with a matching signature
   * (same cwd, accessMode, argv, MCP key) and compatible session id, it is
   * reused without respawning. Otherwise any stale warm process for that
   * thread is torn down first.
   */
  const acquire = async ({
    threadId,
    cwd,
    accessMode,
    commandArgs,
    env,
    mcpKey = '',
    resumeSessionId = null,
    createMcp,
    rebindMcp,
  }) => {
    const key = typeof threadId === 'string' && threadId ? threadId : null;
    const signature = signatureFor({ cwd, accessMode, commandArgs, mcpKey });
    const existing = key ? sessions.get(key) : null;

    if (
      existing &&
      !existing.busy &&
      isAlive(existing) &&
      existing.signature === signature &&
      existing.initialized &&
      Boolean(resumeSessionId && existing.sessionId && existing.sessionId === resumeSessionId)
    ) {
      clearIdleTimer(existing);
      existing.busy = true;
      if (existing.orionMcp && rebindMcp) {
        rebindMcp(existing.orionMcp);
      }
      return makeLease(existing, true);
    }

    if (existing && !existing.busy) {
      await destroyEntry(existing);
    }

    const orionMcp = createMcp ? await createMcp() : null;
    let child;
    try {
      child = spawnProcess({ commandArgs, cwd, env });
    } catch (error) {
      try {
        orionMcp?.release?.();
      } catch {}
      throw error;
    }
    const entry = {
      threadId: key,
      signature,
      cwd,
      accessMode,
      commandArgs,
      child,
      orionMcp,
      busy: true,
      destroyed: false,
      idleTimer: null,
      idleSince: 0,
      exitFallbackTimer: null,
      nextRequestId: 1,
      initialized: null,
      sessionId: null,
      currentModelKey: null,
      currentModeId: null,
      availableModes: [],
      systemPromptAppendApplied: null,
      onMessage: null,
      onStderr: null,
      onClose: null,
      stdoutBuffer: '',
    };

    if (key && !shuttingDown && !sessions.has(key)) {
      sessions.set(key, entry);
    }

    child.stdout?.on?.('data', (data) => {
      entry.stdoutBuffer += data.toString();
      const lines = entry.stdoutBuffer.split(/\r?\n/);
      entry.stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (entry.onMessage) {
          try {
            entry.onMessage(parsed);
          } catch (error) {
            console.error('Antigravity ACP message handler error:', error);
          }
        } else if (!entry.destroyed) {
          // Unexpected traffic while idle: decline any agent->client request so
          // agy never blocks, and recycle the warm process so stale activity
          // cannot bleed into the next turn.
          replyIdleRequest(entry, parsed);
          void destroyEntry(entry);
        }
      }
    });

    child.stderr?.on?.('data', (data) => {
      try {
        entry.onStderr?.(data.toString());
      } catch {}
    });

    const handleTermination = (code, signal) => {
      if (entry.destroyed) return;
      const closeHandler = entry.onClose;
      entry.onMessage = null;
      entry.onStderr = null;
      entry.onClose = null;
      entry.busy = false;
      clearIdleTimer(entry);
      clearExitTimer(entry);
      if (key && sessions.get(key) === entry) {
        sessions.delete(key);
      }
      const mcp = entry.orionMcp;
      entry.orionMcp = null;
      try {
        mcp?.release?.();
      } catch {}
      entry.destroyed = true;
      closeHandler?.(code, signal);
    };

    // An agent-spawned daemon can inherit stdout/stderr pipes and keep 'close'
    // from firing after agy exits: mirror main.js's 2s 'exit' fallback timer.
    child.on?.('exit', (code, signal) => {
      if (entry.destroyed || entry.exitFallbackTimer) return;
      entry.exitFallbackTimer = setTimeout(() => {
        entry.exitFallbackTimer = null;
        handleTermination(code ?? (signal ? 1 : 0), signal ?? null);
      }, 2000);
      entry.exitFallbackTimer.unref?.();
    });
    child.on?.('close', (code, signal) => handleTermination(code, signal));
    child.on?.('error', () => handleTermination(1, null));

    return makeLease(entry, false);
  };

  const makeLease = (entry, reused) => {
    let released = false;
    return {
      reused,
      entry,
      child: entry.child,
      orionMcp: entry.orionMcp,
      nextRequestId: () => entry.nextRequestId++,
      attachHandlers({ onMessage, onStderr, onClose }) {
        entry.onMessage = onMessage ?? null;
        entry.onStderr = onStderr ?? null;
        entry.onClose = onClose ?? null;
      },
      /**
       * Release the lease after a turn finishes.
       * `keepAlive: true` keeps the process warm for the next turn;
       * `keepAlive: false` destroys the process and its MCP bridge lease.
       */
      release: async ({ keepAlive = false } = {}) => {
        if (released) return;
        released = true;
        entry.onMessage = null;
        entry.onStderr = null;
        entry.onClose = null;
        entry.busy = false;
        const canKeep =
          keepAlive &&
          !shuttingDown &&
          entry.threadId &&
          sessions.get(entry.threadId) === entry &&
          isAlive(entry) &&
          Boolean(entry.initialized) &&
          Boolean(entry.sessionId);
        if (canKeep) {
          scheduleIdleRecycle(entry);
          return;
        }
        await destroyEntry(entry);
      },
    };
  };

  const disposeThread = async (threadId) => {
    const entry = sessions.get(threadId);
    if (!entry) return false;
    await destroyEntry(entry);
    return true;
  };

  const shutdown = async () => {
    shuttingDown = true;
    const all = [...sessions.values()];
    sessions.clear();
    await Promise.all(all.map((entry) => destroyEntry(entry)));
  };

  const snapshot = () => ({
    count: sessions.size,
    threads: [...sessions.entries()].map(([threadId, entry]) => ({
      threadId,
      busy: entry.busy,
      sessionId: entry.sessionId,
      alive: isAlive(entry),
    })),
  });

  return {
    acquire,
    disposeThread,
    shutdown,
    snapshot,
  };
};

export const antigravitySessionManager = createAntigravitySessionManager();
