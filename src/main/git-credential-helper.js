import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_ORION_GIT_HOSTS } from './source-control.js';

const execFileAsync = promisify(execFile);

// Plain `git pull` / `git push` against Durango Source, from any terminal or
// git client, should just work once the user is signed in to Durango Code.
// The app's own git operations pass a token per command (runAuthenticatedGit),
// which never helps a git the user runs themselves. So, like `gh auth
// setup-git`, the app registers a git credential helper for the Durango Source
// hosts in the user's global git config:
//
//   [credential "https://git.durango.sh"]
//     helper =
//     helper = !'<userData>/bin/git-credential-durango'
//
// The empty entry drops helpers from lower-priority config (the macOS
// keychain helper that Xcode's git configures for every host), so a password
// saved there can never shadow the sign-in. The helper reads the token the app
// keeps for the bundled CLI (bundled-cli.js ensureCliSignedIn) when git asks,
// so no token is ever written to git config, and signing out takes effect at
// once. It answers only https requests for the Durango Source hosts.

export const GIT_CREDENTIAL_HELPER_NAME = 'git-credential-durango';

/** CLI origins whose saved token Durango Source accepts (cli/orion/src/config.ts EQUIVALENT_ORIGINS). */
const CLI_ORIGINS = ['https://durango.sh', 'https://code.durango.sh', 'https://orioncode.xyz'];

// Runs on Electron's own Node (ELECTRON_RUN_AS_NODE), so it has no imports
// beyond Node builtins. Mirrors bundled-cli.js readCliCredential.
const helperSource = ({ hosts }) => `// Written by Durango Code: answers git's credential requests for Durango Source
// with the Durango Code sign-in. Rewritten on every launch.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOSTS = ${JSON.stringify(hosts)};
const ORIGINS = ${JSON.stringify(CLI_ORIGINS)};

const readJson = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const sameOrigin = (value) => {
  try {
    return ORIGINS.includes(new URL(value).origin);
  } catch {
    return false;
  }
};

const savedToken = () => {
  const env = process.env;
  const originOverride = env.DURANGO_CODE_ORIGIN || env.ORION_ORIGIN;
  // A token for another Durango Code server is no use to these hosts.
  if (originOverride && !sameOrigin(originOverride)) return null;
  const fromEnv = env.DURANGO_CODE_TOKEN || env.ORION_TOKEN;
  if (fromEnv) return fromEnv;
  const configDir = env.DURANGO_CODE_CONFIG_DIR || env.ORION_CONFIG_DIR;
  const all =
    readJson(path.join(configDir || path.join(os.homedir(), '.config', 'durango-code'), 'credentials.json')) ??
    (configDir ? null : readJson(path.join(os.homedir(), '.config', 'orion', 'credentials.json'))) ??
    {};
  for (const origin of ORIGINS) {
    if (typeof all[origin]?.token === 'string' && all[origin].token) return all[origin].token;
  }
  return null;
};

let input = '';
for await (const chunk of process.stdin) input += chunk;
// git also sends "store" and "erase"; the sign-in is managed by Durango Code.
if (process.argv.at(-1) === 'get') {
  const request = {};
  for (const line of input.split('\\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) request[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  const host = String(request.host ?? '').toLowerCase().replace(/:443$/, '');
  const token = request.protocol === 'https' && HOSTS.includes(host) ? savedToken() : null;
  if (token && /^[\\x21-\\x7e]+$/.test(token)) process.stdout.write(\`username=orion\\npassword=\${token}\\n\`);
}
`;

const posixQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const posixShim = ({ execPath, scriptPath }) => `#!/bin/sh
# Written by Durango Code: git credential helper for Durango Source.
ELECTRON_RUN_AS_NODE=1 exec ${posixQuote(execPath)} ${posixQuote(scriptPath)} "$@"
`;

const windowsShim = ({ execPath, scriptPath }) => `@echo off
rem Written by Durango Code: git credential helper for Durango Source.
set ELECTRON_RUN_AS_NODE=1
"${execPath}" "${scriptPath}" %*
`;

const writeIfChanged = async (target, content, mode = 0o644) => {
  try {
    if ((await fs.readFile(target, 'utf8')) === content) {
      await fs.chmod(target, mode);
      return;
    }
  } catch {}
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { mode });
  await fs.rename(temporary, target);
};

/** The `credential.<url>.helper` value that runs the helper at `helperPath`. */
export const gitCredentialHelperCommand = (helperPath) =>
  `!${posixQuote(String(helperPath).replace(/\\/g, '/'))}`;

/**
 * The executable a Durango helper value runs (this app's, or the CLI's
 * `durango-code git-credential`), '' when it is one but unreadable, and null
 * for anyone else's helper.
 */
const durangoHelperPath = (value) => {
  const text = String(value);
  if (!/git-credential/.test(text) || !/durango|orion/i.test(text)) return null;
  const match = /^!'((?:[^']|'\\'')*)'/.exec(text);
  return match ? match[1].replace(/'\\''/g, "'") : '';
};

const gitConfigKey = (host) => `credential.https://${host}.helper`;

const readGlobalHelpers = async (host, { env }) => {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', '--get-all', gitConfigKey(host)], { env });
    return stdout.split('\n').slice(0, -1);
  } catch (error) {
    if (error?.code === 1) return []; // not set
    throw error;
  }
};

/**
 * Points the user's global git config at `command` for each Durango Source
 * host. Leaves a host alone when it already has a helper of its own, or a
 * working Durango helper (the CLI's or another app build's), so two installers
 * never take turns rewriting it. Returns the hosts it changed.
 */
export const configureGlobalGitCredentialHelper = async ({
  command,
  hosts = DEFAULT_ORION_GIT_HOSTS,
  env = process.env,
}) => {
  const changed = [];
  for (const host of hosts) {
    const current = await readGlobalHelpers(host, { env });
    if (current.length === 2 && current[0] === '' && current[1] === command) continue;
    const configured = current.filter(Boolean);
    if (configured.some((value) => durangoHelperPath(value) === null)) continue;
    if (configured.some((value) => existsSync(durangoHelperPath(value)))) continue;
    await execFileAsync('git', ['config', '--global', '--replace-all', gitConfigKey(host), ''], { env });
    await execFileAsync('git', ['config', '--global', '--add', gitConfigKey(host), command], { env });
    changed.push(host);
  }
  return changed;
};

// Without the Command Line Tools, macOS's /usr/bin/git opens an install
// dialog instead of running; never show that at launch.
const gitIsInstalled = async () => {
  if (process.platform !== 'darwin') return true;
  try {
    await execFileAsync('xcode-select', ['-p']);
    return true;
  } catch {
    return false;
  }
};

/**
 * Writes the helper next to the bundled CLI launchers and registers it with
 * git. The Electron binary changes with every update, so this runs on every
 * launch. Returns the helper path, or null when git is not installed.
 */
export const installGitCredentialHelper = async ({
  binDir,
  execPath = process.execPath,
  hosts = DEFAULT_ORION_GIT_HOSTS,
  env = process.env,
  checkGit = gitIsInstalled,
}) => {
  if (!(await checkGit())) return null;
  await fs.mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, `${GIT_CREDENTIAL_HELPER_NAME}.mjs`);
  await writeIfChanged(scriptPath, helperSource({ hosts }));
  const helperPath = path.join(binDir, process.platform === 'win32' ? `${GIT_CREDENTIAL_HELPER_NAME}.cmd` : GIT_CREDENTIAL_HELPER_NAME);
  await writeIfChanged(
    helperPath,
    process.platform === 'win32' ? windowsShim({ execPath, scriptPath }) : posixShim({ execPath, scriptPath }),
    0o755
  );
  await configureGlobalGitCredentialHelper({ command: gitCredentialHelperCommand(helperPath), hosts, env });
  return helperPath;
};
