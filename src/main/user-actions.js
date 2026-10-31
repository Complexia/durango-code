import crypto from 'node:crypto';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loginShell, shellPathSyncPromise } from './shell-env.js';

// User actions on Durango Code's built-in `orion` MCP server
// (request_user_action, resolve_user_action): an agent that needs the user to
// do something outside the chat (sign in in the browser, approve an npm
// login, plug in a device) says so here instead of burying it in its reply.
// The renderer keeps the action on the thread, tints it as needing the user,
// wakes it from Snoozed and pins the action above the composer until it is
// resolved. The call never blocks: the agent keeps working meanwhile.
//
// When the action is done (the user clicks Done or replies, or the request's
// `check` command succeeds), the agent is told without being interrupted: at
// its next tool call while it works, or in a turn of its own once it is idle
// (agent:notifyTurn in main.js). Only the composer's steer interrupts.
//
// Claude runs register the tools on the in-process SDK server
// (claude-driver.js); every other provider reaches them through the stdio
// bridge shim (mcp-bridge-shim.cjs → mcp-bridge.js). The shim duplicates the
// descriptions and schemas below; test-durango-tools.mjs keeps them in sync.

export const USER_ACTION_TOOL_NAMES = Object.freeze(['request_user_action', 'resolve_user_action']);

export const USER_ACTION_MAX_CHARS = 2_000;
export const USER_ACTION_CHECK_MAX_CHARS = 500;

export const USER_ACTION_TOOL_DESCRIPTIONS = Object.freeze({
  request_user_action:
    'Ask the user to do something only they can do outside this chat, such as signing in or authorizing in a browser window you opened (npm login, OAuth, a CLI device code), approving a prompt on their machine, or pasting a value you cannot get yourself. Durango Code marks the thread as needing the user, brings it back from Snoozed, and pins the action above the composer until it is resolved, so it does not get lost in your replies. It returns at once: keep working on anything that does not depend on it, and do not wait or poll for it. Write the action as one clear instruction (what to do, where, and any code to enter). If a command can tell when it is done (`npm whoami`, `gh auth status`), pass it as `check`: Durango Code runs it every few seconds and marks the action done as soon as it succeeds. You are told when the action is done without being interrupted: at your next tool call while you work, or in a new turn if you have ended yours (the thread shows as waiting on the user meanwhile). The message starts with "Done:" and repeats the action, so you need not ask the user to tell you. If the user replies instead, it starts with "Not done:", repeats the action and gives what they said: the ask may be wrong or they may want something else, so follow their reply rather than asking again. Call resolve_user_action with the returned action_id if you see it is done before you are told.',
  resolve_user_action:
    'Clear an action you asked the user for with request_user_action, once it is done (you saw it succeed, or the user said so) or no longer needed. Without action_id, clears every action pending on this thread.',
});

export const USER_ACTION_TOOL_INPUT_SCHEMAS = Object.freeze({
  request_user_action: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          'What the user should do, as one clear instruction, e.g. "Finish the npm login in the browser tab that opened (code ABCD-1234)."',
      },
      url: {
        type: 'string',
        description: 'Link the user should open for it, if any (shown as an Open button)',
      },
      check: {
        type: 'string',
        description:
          'Shell command that exits 0 once the action is done and fails until then, e.g. "npm whoami" or "gh auth status". It runs in the thread\'s directory without a terminal, so it must not prompt. Leave it out if no command can tell.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  resolve_user_action: {
    type: 'object',
    properties: {
      action_id: {
        type: 'string',
        description: 'The action_id request_user_action returned; omit to clear every pending action on this thread',
      },
    },
    additionalProperties: false,
  },
});

const unavailable = 'Durango Code could not show this to the user: its window is no longer available. Ask in your reply instead.';

const sendToRenderer = (getSender, payload) => {
  const sender = getSender?.();
  if (!sender || sender.isDestroyed?.()) return false;
  try {
    sender.send('agent:userAction', payload);
    return true;
  } catch {
    return false;
  }
};

const httpUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

// Outside Full access the user starts the watch from the card: the command
// runs without the permission prompt the agent's own Bash call would get.
const checkSummary = (check, autoWatch) =>
  autoWatch
    ? ` Durango Code runs \`${check}\` every few seconds and marks it done as soon as it succeeds.`
    : ` The card offers to run \`${check}\` every few seconds to tell when it is done; in this access mode the user starts that.`;

/**
 * Runs one user-action tool for the thread `threadId`. Resolves to
 * `{ ok, text }`, never throws. `projectPath` is where a `check` runs;
 * `accessMode` 'full-access' starts watching it at once.
 */
export const runUserActionTool = async (name, args, { getSender, threadId, projectPath, accessMode }) => {
  if (!threadId) return { ok: false, text: 'This agent run is not attached to a Durango Code thread.' };
  if (name === 'request_user_action') {
    const action = typeof args?.action === 'string' ? args.action.trim() : '';
    if (!action) return { ok: false, text: 'request_user_action requires a non-empty string `action` argument.' };
    if (action.length > USER_ACTION_MAX_CHARS) {
      return { ok: false, text: `Keep the action under ${USER_ACTION_MAX_CHARS} characters: one clear instruction.` };
    }
    if (args?.url !== undefined && !httpUrl(args.url)) {
      return { ok: false, text: '`url` must be an http(s) link; leave it out if there is none.' };
    }
    if (args?.check !== undefined && typeof args.check !== 'string') {
      return { ok: false, text: '`check` must be a shell command string; leave it out if there is none.' };
    }
    const check = typeof args?.check === 'string' ? args.check.trim() : '';
    if (check.length > USER_ACTION_CHECK_MAX_CHARS) {
      return { ok: false, text: `Keep \`check\` under ${USER_ACTION_CHECK_MAX_CHARS} characters: one short command.` };
    }
    const id = `ua_${crypto.randomUUID().slice(0, 8)}`;
    const url = httpUrl(args?.url);
    const autoWatch = accessMode === 'full-access';
    const payload = {
      type: 'request',
      threadId,
      id,
      action,
      ...(url ? { url } : {}),
      ...(check ? { check, cwd: projectPath || os.homedir(), autoWatch } : {}),
    };
    if (!sendToRenderer(getSender, payload)) {
      return { ok: false, text: unavailable };
    }
    return {
      ok: true,
      text: `Shown to the user as action_id ${id}: the thread is marked as needing them and the action stays pinned above the composer.${check ? checkSummary(check, autoWatch) : ''} Keep working on whatever does not depend on it. You are told when it is done without being interrupted, so do not wait or poll for it; call resolve_user_action with action_id ${id} if you see it is done first.`,
    };
  }
  if (name === 'resolve_user_action') {
    const id = typeof args?.action_id === 'string' && args.action_id.trim() ? args.action_id.trim() : undefined;
    unwatchUserActions({ threadId, id });
    if (!sendToRenderer(getSender, { type: 'resolve', threadId, ...(id ? { id } : {}) })) {
      return { ok: false, text: unavailable };
    }
    return { ok: true, text: id ? `Cleared action ${id}.` : 'Cleared every pending action on this thread.' };
  }
  return { ok: false, text: `Unknown tool: ${name}` };
};

// Watching a request's `check`: Durango Code runs the command in the thread's
// directory on a backing-off schedule until it exits 0 (the action is done:
// the renderer clears the card and tells the agent), the action is resolved,
// or USER_ACTION_WATCH_MAX_MS passes (the card offers the watch again). The
// renderer owns which actions are watched and re-arms them after a restart,
// so this registry only holds the live timers.
export const USER_ACTION_WATCH_FIRST_DELAY_MS = 3_000;
export const USER_ACTION_WATCH_MAX_DELAY_MS = 30_000;
export const USER_ACTION_WATCH_MAX_MS = 6 * 60 * 60_000;
export const USER_ACTION_CHECK_TIMEOUT_MS = 20_000;

const userActionWatches = new Map(); // action id -> { threadId, timer, stopped, abort }

export const USER_ACTION_CHECK_KILL_GRACE_MS = 2_000;

// Resolves true when `check` exits 0, false on failure, timeout or `signal`
// abort; never throws, and always settles. The command runs in its own
// process group with stdin closed (a prompt fails instead of hanging); a
// timeout or abort sends the whole group SIGTERM, then SIGKILL.
export const runUserActionCheck = async (
  check,
  cwd,
  { timeoutMs = USER_ACTION_CHECK_TIMEOUT_MS, signal } = {}
) => {
  await shellPathSyncPromise;
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let child;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(ok);
    };
    const killGroup = (killSignal) => {
      if (process.platform === 'win32') {
        // No process groups: taskkill takes the whole tree (and is already
        // forceful, so the later SIGKILL round is a harmless repeat).
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => {
          try {
            child.kill(killSignal);
          } catch {}
        });
        return;
      }
      try {
        process.kill(-child.pid, killSignal);
      } catch {
        try {
          child.kill(killSignal);
        } catch {}
      }
    };
    // SIGKILL goes to the group whether or not the shell is still there: a
    // shell SIGTERM ended can leave descendants that ignored it.
    const stop = () => {
      if (child?.pid) {
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), USER_ACTION_CHECK_KILL_GRACE_MS).unref?.();
      }
      settle(false);
    };
    try {
      const [shell, shellArgs] =
        process.platform === 'win32'
          ? // As Node's own `shell: true`: /s strips the outer quotes.
            [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${check}"`]]
          : [loginShell, ['-c', check]];
      child = spawn(shell, shellArgs, {
        cwd: cwd && existsSync(cwd) ? cwd : os.homedir(),
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32',
      });
    } catch {
      settle(false);
      return;
    }
    child.once('error', () => settle(false));
    child.once('exit', (code) => settle(code === 0));
    timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
  });
};

export const isWatchingUserAction = (id) => userActionWatches.has(id);

/**
 * Starts watching action `id` (no-op when it already is). Reports
 * `{ type: 'detected' }` or `{ type: 'watch-stopped' }` on `agent:userAction`.
 */
export const watchUserAction = (
  { threadId, id, check, cwd, getSender },
  {
    runCheck = runUserActionCheck,
    firstDelayMs = USER_ACTION_WATCH_FIRST_DELAY_MS,
    maxDelayMs = USER_ACTION_WATCH_MAX_DELAY_MS,
    maxMs = USER_ACTION_WATCH_MAX_MS,
  } = {}
) => {
  if (!threadId || typeof id !== 'string' || !id) return false;
  const command = typeof check === 'string' ? check.trim() : '';
  if (!command || command.length > USER_ACTION_CHECK_MAX_CHARS) return false;
  if (userActionWatches.has(id)) return true;
  const startedAt = Date.now();
  // abort ends a check that is running when the watch stops.
  const watch = { threadId, timer: null, stopped: false, abort: new AbortController() };
  userActionWatches.set(id, watch);
  const finish = (type) => {
    if (userActionWatches.get(id) === watch) userActionWatches.delete(id);
    watch.stopped = true;
    sendToRenderer(getSender, { type, threadId, id });
  };
  const schedule = (delayMs) => {
    watch.timer = setTimeout(async () => {
      if (watch.stopped) return;
      const done = await runCheck(command, cwd, { signal: watch.abort.signal });
      if (watch.stopped) return;
      if (done) return finish('detected');
      if (Date.now() - startedAt >= maxMs) return finish('watch-stopped');
      schedule(Math.min(delayMs * 2, maxDelayMs));
    }, delayMs);
    watch.timer.unref?.();
  };
  schedule(firstDelayMs);
  return true;
};

/**
 * Stops watching action `id` on `threadId`, or every action on `threadId`
 * without `id`. With both, both must match: another thread's action is not
 * this thread's to stop.
 */
export const unwatchUserActions = ({ threadId, id } = {}) => {
  if (!threadId && !id) return;
  for (const [watchedId, watch] of userActionWatches) {
    if ((id && watchedId !== id) || (threadId && watch.threadId !== threadId)) continue;
    watch.stopped = true;
    clearTimeout(watch.timer);
    watch.abort.abort();
    userActionWatches.delete(watchedId);
  }
};
