// Restarting the app (after an update, or from the renderer) on Linux.
//
// Electron's app.relaunch() starts its relauncher helper through Chromium's
// base::LaunchProcess with default options, and on Linux those set
// PR_SET_NO_NEW_PRIVS. The helper starts the new app, which inherits the flag
// for its whole life: setuid programs then run without their privileges, so
// the next in-app update fails ("pkexec must be setuid root") and so does sudo
// in its terminals and agent shells. On Linux the app is restarted by a
// detached shell instead (Node's spawn sets no such flag) that waits for this
// process to exit, so the new one can take the single-instance lock.

import { spawn } from 'node:child_process';

// Waits for the old process (at most about 5 minutes), then becomes the app.
const WAIT_THEN_EXEC =
  'i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 3000 ]; do sleep 0.1; i=$((i+1)); done; shift; exec "$@"';

/** [program, args] of the detached restart: waits for `pid`, then runs the app. */
export const linuxRelaunchCommand = ({ pid, execPath, args }) => [
  '/bin/sh',
  ['-c', WAIT_THEN_EXEC, 'durango-code-relaunch', String(pid), execPath, ...args],
];

/**
 * Schedule a restart for when this process exits (call app.quit()/exit()
 * after it), like app.relaunch(). Other platforms use app.relaunch().
 */
export const relaunchApp = (
  app,
  {
    platform = process.platform,
    env = process.env,
    argv = process.argv,
    execPath = process.execPath,
    pid = process.pid,
    spawnProcess = spawn,
  } = {}
) => {
  if (platform !== 'linux') {
    app.relaunch();
    return;
  }
  // An AppImage's execPath is inside its mount, which goes away on exit.
  const [program, args] = linuxRelaunchCommand({ pid, execPath: env.APPIMAGE || execPath, args: argv.slice(1) });
  try {
    const child = spawnProcess(program, args, { detached: true, stdio: 'ignore', env });
    child.on?.('error', () => {});
    child.unref?.();
  } catch {
    app.relaunch();
  }
};
