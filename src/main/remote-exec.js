import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Shell commands a paired controller runs on this machine (remote control's
// `exec` request, used by the machine_exec agent tool on the controller).
//
// Runs the command with the user's login shell (`$SHELL -lc`, cmd.exe on
// Windows), in the user's home folder unless the controller names a folder,
// with this app's environment (its PATH is the user's shell PATH, see
// shell-env.js). It never needs the renderer: the command is not an agent
// turn, so nothing is added to this machine's threads.
//
// Output is kept up to EXEC_MAX_OUTPUT_BYTES per stream (the head and the
// tail, the middle is dropped and announced), so a chatty command never
// grows the reply past one remote-control frame. The command ends at its
// timeout (EXEC_MAX_TIMEOUT_MS at most), when the controller cancels it, or
// when the controller's session closes: the whole process group is
// terminated, then killed 3 seconds later. A background process the command
// started that keeps stdout open does not hold the reply: the result is sent
// shortly after the shell itself exits.

export const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
export const EXEC_MAX_COMMAND_CHARS = 100_000;
export const EXEC_MAX_STDIN_BYTES = 1024 * 1024;
export const EXEC_MAX_OUTPUT_BYTES = 512 * 1024;
const EXEC_DRAIN_AFTER_EXIT_MS = 300;
const EXEC_KILL_GRACE_MS = 3_000;

const loginShell = () => process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

/** Keeps the first and last half of the budget, counting what was dropped. */
const createOutputBuffer = (limit) => {
  const half = Math.floor(limit / 2);
  let head = Buffer.alloc(0);
  const tail = [];
  let tailBytes = 0;
  let total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      if (head.length < half) {
        const take = Math.min(half - head.length, chunk.length);
        head = Buffer.concat([head, chunk.subarray(0, take)]);
        chunk = chunk.subarray(take);
      }
      if (chunk.length === 0) return;
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tailBytes > limit - half && tail.length > 0) {
        const extra = tailBytes - (limit - half);
        if (tail[0].length <= extra) {
          tailBytes -= tail.shift().length;
        } else {
          tail[0] = tail[0].subarray(extra);
          tailBytes -= extra;
        }
      }
    },
    read() {
      const kept = head.length + tailBytes;
      const dropped = total - kept;
      // Decoded as one buffer when nothing was dropped, so a character split
      // between head and tail stays whole.
      return {
        text:
          dropped > 0
            ? `${head.toString('utf8')}\n…[${dropped} bytes omitted]…\n${Buffer.concat(tail).toString('utf8')}`
            : Buffer.concat([head, ...tail]).toString('utf8'),
        bytes: total,
        truncated: dropped > 0,
      };
    },
  };
};

const expandHome = (value) =>
  value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;

/**
 * Where the command runs: `cwd` (absolute, `~/…`, or relative to `baseDir`),
 * else `baseDir`, else the home folder. Must be an existing folder.
 */
export const resolveExecCwd = async ({ cwd, baseDir } = {}) => {
  const base = typeof baseDir === 'string' && baseDir ? baseDir : os.homedir();
  const raw = typeof cwd === 'string' ? cwd.trim() : '';
  const target = raw ? path.resolve(base, expandHome(raw)) : base;
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new Error(`No folder ${target} on this machine.`);
  }
  if (!stat.isDirectory()) throw new Error(`${target} is not a folder.`);
  return target;
};

const killTree = (child, signal) => {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
        'error',
        () => {}
      );
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
};

/**
 * Runs one command. Resolves (never rejects) with
 * { ok, exitCode, signal, stdout, stderr, stdoutBytes, stderrBytes,
 *   stdoutTruncated, stderrTruncated, timedOut, cancelled, durationMs, cwd }
 * or { ok: false, error } when it could not start.
 */
export const runExecCommand = async ({
  command,
  cwd,
  baseDir,
  stdin,
  timeoutMs,
  signal,
  env,
  maxOutputBytes = EXEC_MAX_OUTPUT_BYTES,
} = {}) => {
  const text = typeof command === 'string' ? command : '';
  if (!text.trim()) return { ok: false, error: 'Empty command.' };
  if (text.length > EXEC_MAX_COMMAND_CHARS) {
    return { ok: false, error: `The command is longer than ${EXEC_MAX_COMMAND_CHARS} characters.` };
  }
  const input = typeof stdin === 'string' ? Buffer.from(stdin, 'utf8') : null;
  if (input && input.length > EXEC_MAX_STDIN_BYTES) {
    return { ok: false, error: 'stdin is larger than 1 MB.' };
  }
  let workingDirectory;
  try {
    workingDirectory = await resolveExecCwd({ cwd, baseDir });
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  if (signal?.aborted) return { ok: false, error: 'Cancelled.' };
  const limit = Math.min(
    EXEC_MAX_TIMEOUT_MS,
    Math.max(1_000, Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : EXEC_DEFAULT_TIMEOUT_MS)
  );
  const startedAt = Date.now();
  const childEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...(env ?? {}) };
  // Never hand this app's own Electron-as-Node switch to the command.
  delete childEnv.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve) => {
    let child;
    try {
      child =
        process.platform === 'win32'
          ? spawn(text, { cwd: workingDirectory, env: childEnv, shell: true, windowsHide: true })
          : spawn(loginShell(), ['-lc', text], { cwd: workingDirectory, env: childEnv, detached: true });
    } catch (error) {
      resolve({ ok: false, error: `Could not start the command: ${error?.message ?? error}` });
      return;
    }
    const stdout = createOutputBuffer(maxOutputBytes);
    const stderr = createOutputBuffer(maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let exit = null;
    let drainTimer = null;
    let killTimer = null;

    const finish = (startError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      signal?.removeEventListener?.('abort', onAbort);
      // Background processes may still hold the pipes; stop reading them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (startError) {
        clearTimeout(killTimer);
        resolve({ ok: false, error: `Could not start the command: ${startError.message ?? startError}` });
        return;
      }
      const out = stdout.read();
      const err = stderr.read();
      resolve({
        ok: true,
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        stdout: out.text,
        stderr: err.text,
        stdoutBytes: out.bytes,
        stderrBytes: err.bytes,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        timedOut,
        cancelled,
        durationMs: Date.now() - startedAt,
        cwd: workingDirectory,
      });
    };

    const terminate = () => {
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), EXEC_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, limit);
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => finish(error));
    child.on('exit', (code, exitSignal) => {
      exit = { code, signal: exitSignal };
      drainTimer = setTimeout(() => finish(), EXEC_DRAIN_AFTER_EXIT_MS);
    });
    child.on('close', () => finish());
    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (input) child.stdin.end(input);
      else child.stdin.end();
    }
  });
};
