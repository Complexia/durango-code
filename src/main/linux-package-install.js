// Installs a downloaded Linux update (.pacman or .deb) in place of
// electron-updater's own Linux install. That one runs pkexec through
// spawnSync (freezing the app while the password dialog is up), retries a
// failed `pacman -U` after a `pacman -Sy` (a partial sync, and two more
// password prompts), and reports only "Command pkexec exited with code 127"
// without what pkexec said. Here a single pkexec call runs the package
// manager directly, without blocking, and a failure says why and what to run
// by hand.

import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const SYSTEM_BIN_DIRS = ['/usr/bin', '/usr/sbin', '/bin', '/sbin'];

// pkexec exit codes: 126 when the user dismissed the password dialog, 127
// when authorization failed or could not be asked for (no polkit agent).
const PKEXEC_DISMISSED = 126;
const PKEXEC_NOT_AUTHORIZED = 127;

/** 'pacman' or 'deb' from resources/package-type, else null (AppImage, dev). */
export const readLinuxPackageType = async (resourcesPath) => {
  try {
    const type = (await readFile(path.join(resourcesPath, 'package-type'), 'utf8')).trim();
    return type === 'pacman' || type === 'deb' ? type : null;
  } catch {
    return null;
  }
};

const defaultFindExecutable = async (name) => {
  for (const dir of SYSTEM_BIN_DIRS) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
};

/**
 * The package-manager command (absolute program first: pkexec only runs
 * absolute paths) that installs `file`, or null when none is installed.
 */
export const linuxInstallCommand = async (type, file, findExecutable = defaultFindExecutable) => {
  if (type === 'pacman') {
    const pacman = await findExecutable('pacman');
    return pacman ? [pacman, '-U', '--noconfirm', file] : null;
  }
  if (type === 'deb') {
    // apt-get resolves the package's dependencies; dpkg alone does not.
    const aptGet = await findExecutable('apt-get');
    if (aptGet) return [aptGet, 'install', '-y', '--allow-downgrades', file];
    const dpkg = await findExecutable('dpkg');
    return dpkg ? [dpkg, '-i', file] : null;
  }
  return null;
};

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** The command a user can paste into a terminal to install the update. */
export const manualInstallCommand = (command) =>
  ['sudo', path.basename(command[0]), ...command.slice(1)].map((part, index) =>
    index === 0 || /^[\w@%+=:,./-]+$/.test(part) ? part : shellQuote(part)
  ).join(' ');

const lastLines = (text, count = 3) =>
  String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' ');

/**
 * The message for a failed install. `viaPkexec` says whether the exit code
 * is pkexec's own (126/127) or may be the package manager's.
 */
export const describeLinuxInstallFailure = ({ code, stderr, viaPkexec, command }) => {
  const detail = lastLines(stderr);
  const manual = `To install it from a terminal instead, run: ${manualInstallCommand(command)}`;
  if (viaPkexec && code === PKEXEC_NOT_AUTHORIZED) {
    const reason = /no authentication agent/i.test(detail)
      ? 'no polkit authentication agent is running to ask for your password'
      : detail
        ? `pkexec said: ${detail}`
        : 'pkexec could not get permission';
    return `Durango Code could not get permission to install the update (${reason}). ${manual}`;
  }
  const what = path.basename(command[0]);
  return `${what} could not install the update${detail ? `: ${detail}` : ` (exit code ${code ?? 'unknown'})`}. ${manual}`;
};

const runCommand = (program, args, { env } = {}) =>
  new Promise((resolve) => {
    let stderr = '';
    let stdout = '';
    let child;
    try {
      child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout, stderr: error?.message ?? String(error) });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-64 * 1024);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });
    child.on('error', (error) => {
      resolve({ code: null, stdout, stderr: `${stderr}\n${error?.message ?? String(error)}` });
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

/**
 * Install the downloaded package. Resolves to { ok: true },
 * { ok: false, cancelled: true } when the password dialog was dismissed, or
 * { ok: false, error } with a message that names the cause and the manual
 * command.
 */
export const installLinuxPackage = async ({
  type,
  file,
  isRoot = process.getuid?.() === 0,
  findExecutable = defaultFindExecutable,
  run = runCommand,
  env = process.env,
}) => {
  if (!file) return { ok: false, error: 'The downloaded update could not be found. Download it again.' };
  const command = await linuxInstallCommand(type, file, findExecutable);
  if (!command) {
    return {
      ok: false,
      error:
        type === 'pacman'
          ? 'pacman was not found, so the update cannot be installed.'
          : 'Neither apt-get nor dpkg was found, so the update cannot be installed.',
    };
  }

  let program = command[0];
  let args = command.slice(1);
  let viaPkexec = false;
  if (!isRoot) {
    const pkexec = await findExecutable('pkexec');
    if (!pkexec) {
      return {
        ok: false,
        error: `Installing needs administrator rights and pkexec is not installed. To install it from a terminal, run: ${manualInstallCommand(command)}`,
      };
    }
    // The internal agent asks on the terminal Durango Code was started from,
    // where nobody is looking; only the desktop's polkit agent should ask.
    args = ['--disable-internal-agent', ...command];
    program = pkexec;
    viaPkexec = true;
  }

  const { code, stderr } = await run(program, args, { env });
  if (code === 0) return { ok: true };
  if (viaPkexec && code === PKEXEC_DISMISSED) return { ok: false, cancelled: true };
  return { ok: false, error: describeLinuxInstallFailure({ code, stderr, viaPkexec, command }) };
};
