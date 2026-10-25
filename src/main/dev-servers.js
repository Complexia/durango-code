import path from 'node:path';
import { execFileAsync } from './shell-env.js';

// Dev-server discovery for Settings > Dev Servers. There is no registry of
// agent-spawned servers (a background `npm run dev` outlives its run and gets
// reparented to launchd), so every scan rebuilds the picture from the OS:
// lsof for listening TCP sockets and working directories, ps for resources
// and ancestry. Attribution to a thread is best-effort, strongest first:
//   1. the server is a descendant of a live agent CLI process (run registry)
//   2. the server is a descendant of a thread's embedded terminal PTY
//   3. the server's cwd matches a live Claude SDK session's project path
// Anything else is matched renderer-side by cwd against project/workspace roots.

const TOOL_TIMEOUT_MS = 10000;

// Some tools use a documented nonzero exit for a useful partial/empty result.
// Only salvage those explicit exits: spawn failures, timeouts, signals, and
// every other exit must stay visible to the caller.
export const runTool = async (file, args, { acceptedExitCodes = [] } = {}) => {
  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 8,
    });
    return stdout || '';
  } catch (error) {
    if (
      typeof error?.code === 'number' &&
      acceptedExitCodes.includes(error.code) &&
      error?.killed !== true &&
      !error?.signal &&
      typeof error?.stdout === 'string'
    ) {
      return error.stdout;
    }
    throw error;
  }
};

// macOS reports /private/var paths where the store holds /var (and vice
// versa); compare with the alias stripped so workspace cwd matches don't miss.
export const normalizeCwd = (value) => {
  if (typeof value !== 'string' || !value) return null;
  const resolved = path.resolve(value);
  return resolved.startsWith('/private/') ? resolved.slice('/private'.length) : resolved;
};

const isUnderRoot = (dir, root) => dir === root || dir.startsWith(root + path.sep);

// `lsof -Fpcn` field output: `p<pid>` opens a process section, `c<command>`
// names it, and each socket contributes an `n<addr:port>` line.
const parseListeners = (stdout) => {
  const byPid = new Map(); // pid -> { pid, command, ports: Set }
  let current = null;
  for (const line of String(stdout).split('\n')) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      const pid = Number.parseInt(value, 10);
      current = Number.isFinite(pid) ? byPid.get(pid) ?? { pid, command: '', ports: new Set() } : null;
      if (current) byPid.set(current.pid, current);
    } else if (field === 'c' && current) {
      current.command = value;
    } else if (field === 'n' && current) {
      const port = Number.parseInt(value.slice(value.lastIndexOf(':') + 1), 10);
      if (Number.isFinite(port) && port > 0) current.ports.add(port);
    }
  }
  return byPid;
};

const listListeners = async () =>
  parseListeners(
    await runTool('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { acceptedExitCodes: [1] })
  );

// `lsof -d cwd -Fpn` over a pid list: one `p` line per process, `n` is the
// working directory.
const readCwds = async (pids) => {
  const cwds = new Map();
  if (pids.length === 0) return cwds;
  const stdout = await runTool('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], {
    acceptedExitCodes: [1],
  });
  let currentPid = null;
  for (const line of String(stdout).split('\n')) {
    if (!line) continue;
    if (line[0] === 'p') currentPid = Number.parseInt(line.slice(1), 10);
    else if (line[0] === 'n' && Number.isFinite(currentPid)) cwds.set(currentPid, normalizeCwd(line.slice(1)));
  }
  return cwds;
};

const readParentMap = async () => {
  const parents = new Map(); // pid -> ppid
  const stdout = await runTool('ps', ['-axo', 'pid=,ppid=']);
  for (const line of String(stdout).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
};

// ps etime: [[dd-]hh:]mm:ss
const parseEtimeMs = (value) => {
  const match = String(value ?? '').trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  ) * 1000;
};

const readStats = async (pids) => {
  const stats = new Map(); // pid -> { cpuPercent, memoryBytes, startedAt, commandLine }
  if (pids.length === 0) return stats;
  const now = Date.now();
  const stdout = await runTool('ps', ['-o', 'pid=,pcpu=,rss=,etime=,command=', '-p', pids.join(',')]);
  for (const line of String(stdout).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const elapsed = parseEtimeMs(match[4]);
    stats.set(Number(match[1]), {
      cpuPercent: Number.parseFloat(match[2]),
      memoryBytes: Number(match[3]) * 1024,
      startedAt: elapsed === null ? null : now - elapsed,
      commandLine: match[5].trim(),
    });
  }
  return stats;
};

const collectAncestors = (pid, parents) => {
  const chain = [];
  let current = parents.get(pid);
  // Depth cap guards against a cyclic ps snapshot (pid reuse mid-read).
  while (Number.isFinite(current) && current > 1 && chain.length < 32) {
    chain.push(current);
    current = parents.get(current);
  }
  return chain;
};

export const uniqueSessionThreadsByCwd = (sessionThreadCwds) => {
  const threadIdsByCwd = new Map();
  for (const entry of sessionThreadCwds) {
    const cwd = normalizeCwd(entry?.cwd);
    if (!cwd || typeof entry?.threadId !== 'string' || !entry.threadId) continue;
    const threadIds = threadIdsByCwd.get(cwd) ?? new Set();
    threadIds.add(entry.threadId);
    threadIdsByCwd.set(cwd, threadIds);
  }
  const unique = new Map();
  for (const [cwd, threadIds] of threadIdsByCwd) {
    if (threadIds.size === 1) unique.set(cwd, threadIds.values().next().value);
  }
  return unique;
};

export const devServerUrlForPort = (value) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid dev server port.');
  }
  return `http://localhost:${port}`;
};

export const listDevServers = async ({
  roots = [],
  agentPidThreads = [],
  terminalPidThreads = [],
  sessionThreadCwds = [],
} = {}) => {
  if (process.platform === 'win32') {
    return { ok: false, servers: [], error: 'Dev server discovery is not supported on Windows yet.' };
  }
  try {
    const listeners = await listListeners();
    listeners.delete(process.pid);
    const pids = [...listeners.keys()];
    const [cwds, stats, parents] = await Promise.all([readCwds(pids), readStats(pids), readParentMap()]);

    const agentByPid = new Map(agentPidThreads.map((entry) => [entry.pid, entry.threadId]));
    const terminalByPid = new Map(terminalPidThreads.map((entry) => [entry.pid, entry.threadId]));
    // A cwd shared by multiple persistent Claude sessions is ambiguous. Leave
    // it unattributed here so the renderer can use current thread status and
    // activity instead of whichever session happened to be inserted last.
    const sessionByCwd = uniqueSessionThreadsByCwd(sessionThreadCwds);
    const normalizedRoots = roots.map(normalizeCwd).filter(Boolean);
    const orionAncestors = new Set([process.pid, ...collectAncestors(process.pid, parents)]);

    const servers = [];
    for (const listener of listeners.values()) {
      // Never surface Orion's own process tree upward (Terminal, launchd, an
      // IDE running the app) as killable servers.
      if (orionAncestors.has(listener.pid)) continue;
      const cwd = cwds.get(listener.pid) ?? null;

      let threadId = null;
      let threadSource = null;
      for (const ancestor of [listener.pid, ...collectAncestors(listener.pid, parents)]) {
        if (agentByPid.has(ancestor)) {
          threadId = agentByPid.get(ancestor);
          threadSource = 'agent';
          break;
        }
        if (terminalByPid.has(ancestor)) {
          threadId = terminalByPid.get(ancestor);
          threadSource = 'terminal';
          break;
        }
      }
      if (!threadId && cwd && sessionByCwd.has(cwd)) {
        threadId = sessionByCwd.get(cwd);
        threadSource = 'session';
      }

      // Only processes tied to Orion's world: attributed to a thread, or
      // working inside a known project/workspace root. Everything else on the
      // machine (browsers, system daemons) is out of scope.
      const inKnownRoot = cwd !== null && normalizedRoots.some((root) => isUnderRoot(cwd, root));
      if (!threadId && !inKnownRoot) continue;

      const stat = stats.get(listener.pid);
      servers.push({
        pid: listener.pid,
        command: listener.command,
        commandLine: stat?.commandLine || listener.command,
        ports: [...listener.ports].sort((a, b) => a - b),
        cwd,
        cpuPercent: stat?.cpuPercent ?? null,
        memoryBytes: stat?.memoryBytes ?? null,
        startedAt: stat?.startedAt ?? null,
        threadId,
        threadSource,
      });
    }
    servers.sort((a, b) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0));
    return { ok: true, servers };
  } catch (error) {
    return { ok: false, servers: [], error: error instanceof Error ? error.message : String(error) };
  }
};

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but is not ours — treat as alive so the caller
    // reports the failure instead of claiming a kill.
    return error?.code === 'EPERM';
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForExit = async (pid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(150);
  }
  return !isAlive(pid);
};

// targets: [{ pid, port }]. The port doubles as an identity check — a scan
// result can be a few seconds stale, and a recycled pid must not be killed on
// the strength of a row the user selected before the original exited.
export const killDevServers = async ({ targets = [] } = {}) => {
  if (process.platform === 'win32') {
    return { ok: false, results: [], error: 'Dev server management is not supported on Windows yet.' };
  }
  let listeners;
  let parents;
  try {
    [listeners, parents] = await Promise.all([listListeners(), readParentMap()]);
  } catch (error) {
    return { ok: false, results: [], error: error instanceof Error ? error.message : String(error) };
  }
  const protectedPids = new Set([process.pid, ...collectAncestors(process.pid, parents)]);

  const results = [];
  for (const target of targets) {
    const pid = Number(target?.pid);
    const port = Number(target?.port);
    if (!Number.isFinite(pid) || pid <= 1) {
      results.push({ pid, ok: false, error: 'Invalid process id.' });
      continue;
    }
    if (protectedPids.has(pid)) {
      results.push({ pid, ok: false, error: 'Refusing to kill Durango Code or one of its parent processes.' });
      continue;
    }
    const listener = listeners.get(pid);
    if (!listener) {
      results.push({ pid, ok: true, alreadyExited: true });
      continue;
    }
    if (Number.isFinite(port) && port > 0 && !listener.ports.has(port)) {
      results.push({
        pid,
        ok: false,
        error: `Process ${pid} is no longer listening on port ${port} — rescan before killing.`,
      });
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (error?.code === 'ESRCH') {
        results.push({ pid, ok: true, alreadyExited: true });
      } else {
        results.push({ pid, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    if (await waitForExit(pid, 2000)) {
      results.push({ pid, ok: true });
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    if (await waitForExit(pid, 1500)) {
      results.push({ pid, ok: true });
    } else {
      results.push({ pid, ok: false, error: `Process ${pid} survived SIGTERM and SIGKILL.` });
    }
  }
  return { ok: results.every((entry) => entry.ok), results };
};
