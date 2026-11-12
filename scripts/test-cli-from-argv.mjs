import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { cliArgsFromArgv } from '../src/main/cli-argv.js';

// The app binary started as the `durango-code` CLI (/usr/bin/durango-code on
// Linux is the app): cli-argv.js decides, run-cli-from-argv.js runs the
// bundled CLI in the foreground and exits with its code.

// --- Which launches are CLI calls -------------------------------------------------

const exe = '/usr/lib/durango-code/durango-code';
assert.deepEqual(cliArgsFromArgv([exe, 'ws', 'new', 'rich-messages']), ['ws', 'new', 'rich-messages']);
assert.deepEqual(cliArgsFromArgv([exe, 'change', 'create', '--title', 'x']), ['change', 'create', '--title', 'x']);
assert.deepEqual(cliArgsFromArgv([exe, 'land', '--all']), ['land', '--all']);
assert.deepEqual(cliArgsFromArgv([exe, 'git-credential', 'get']), ['git-credential', 'get']);
for (const flag of ['--version', '-v', '--help', '-h']) assert.deepEqual(cliArgsFromArgv([exe, flag]), [flag]);
// Development: `electron . ws list`.
assert.deepEqual(cliArgsFromArgv(['electron', '.', 'ws', 'list'], { defaultApp: true }), ['ws', 'list']);

// Ordinary app launches stay app launches.
assert.equal(cliArgsFromArgv([exe]), null);
assert.equal(cliArgsFromArgv([exe, 'orion://auth/callback?code=abc']), null);
assert.equal(cliArgsFromArgv([exe, '--no-sandbox']), null);
assert.equal(cliArgsFromArgv([exe, '--password-store=gnome-libsecret']), null);
assert.equal(cliArgsFromArgv([exe, '/home/me/project']), null);
assert.equal(cliArgsFromArgv(['electron', '.'], { defaultApp: true }), null);
// Options before the command, with or without a value.
assert.deepEqual(cliArgsFromArgv([exe, '--json', 'ws', 'list']), ['--json', 'ws', 'list']);
assert.deepEqual(cliArgsFromArgv([exe, '--path', '/repo', 'status']), ['--path', '/repo', 'status']);
assert.deepEqual(cliArgsFromArgv([exe, '--path=/repo', 'status']), ['--path=/repo', 'status']);
assert.deepEqual(cliArgsFromArgv([exe, '--json', '--version']), ['--json', '--version']);
// A plain positional before any command word is an app launch.
assert.equal(cliArgsFromArgv([exe, '--password-store=gnome-libsecret', 'orion://auth/callback?code=abc']), null);
assert.equal(cliArgsFromArgv([exe, '--no-sandbox', '/home/me/project']), null);
assert.equal(cliArgsFromArgv([exe, 'orion://auth/callback', 'ws']), null);
// Not a CLI command word.
assert.equal(cliArgsFromArgv([exe, 'wsx']), null);

// --- End to end, in Electron -------------------------------------------------------

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = process.env.ORION_BUNDLED_CLI_DIR || path.join(codeRoot, 'node_modules', 'durango-code');
if (!existsSync(path.join(cliDir, 'dist', 'index.js'))) {
  const message = `no bundled CLI at ${cliDir} (install dependencies, or set ORION_BUNDLED_CLI_DIR)`;
  if (process.env.CI) throw new Error(`test-cli-from-argv: ${message}`);
  console.log(`test-cli-from-argv: skipped the Electron run: ${message}`);
  process.exit(0);
}
const cliVersion = JSON.parse(readFileSync(path.join(cliDir, 'package.json'), 'utf8')).version;

const testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orion-cli-argv-test-')));
const userData = path.join(testRoot, 'userData');
const fixture = path.join(codeRoot, 'scripts', `.orion-cli-argv-${process.pid}.mjs`);
await fs.writeFile(
  path.join(testRoot, 'entry.mjs'),
  `import { app } from 'electron';
app.setPath('userData', ${JSON.stringify(userData)});
await import(${JSON.stringify(path.join(codeRoot, 'src', 'main', 'run-cli-from-argv.js'))});
// Reached only when the launch was not a CLI call.
console.log('APP-STARTED');
app.exit(0);
`
);
try {
  await build({ entryPoints: [path.join(testRoot, 'entry.mjs')], outfile: fixture, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
  const electron = createRequire(import.meta.url)('electron');
  const run = (args) => {
    const result = spawnSync(electron, [fixture, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: path.join(testRoot, 'home'),
        ORION_BUNDLED_CLI_DIR: cliDir,
        DURANGO_CODE_TOKEN: '',
        ELECTRON_RUN_AS_NODE: '',
        ORION_DEV_USER_DATA: '',
        NO_COLOR: '1',
      },
    });
    if (result.error) throw result.error;
    return result;
  };
  await fs.mkdir(path.join(testRoot, 'home'));

  const version = run(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), cliVersion);
  assert.doesNotMatch(version.stdout, /APP-STARTED/);
  // Every launcher was written before ready, into the dev profile (this is an
  // unpackaged run), never the installed app's.
  const devBin = path.join(`${userData} (dev)`, 'bin');
  for (const name of ['durango-code.mjs', 'durango-code', 'ds', 'durango-source', 'orion-cli']) {
    assert.ok(existsSync(path.join(devBin, name)), `${name} in the dev profile`);
  }
  assert.equal(existsSync(path.join(userData, 'bin')), false);

  // Options before the command.
  const leading = run(['--json', 'ws', 'list']);
  assert.equal(leading.status, 0, leading.stderr);
  assert.match(leading.stdout.trim().split('\n').at(-1), /^\{/);
  assert.doesNotMatch(leading.stdout, /APP-STARTED/);

  // The CLI's exit code comes through.
  const missing = run(['ws', 'path', 'no-such-workspace']);
  assert.equal(missing.signal, null);
  assert.equal(typeof missing.status, 'number');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no-such-workspace/);
  assert.doesNotMatch(missing.stdout, /APP-STARTED/);

  // Killing the app process (it waits in spawnSync, so it cannot forward the
  // signal) does not leave the CLI running: a stub CLI that only waits.
  const stubCli = path.join(testRoot, 'stub-cli');
  await fs.mkdir(path.join(stubCli, 'dist'), { recursive: true });
  await fs.writeFile(path.join(stubCli, 'package.json'), JSON.stringify({ name: 'durango-code', version: '0.0.0-stub', type: 'module' }));
  await fs.writeFile(path.join(stubCli, 'dist', 'index.js'), "console.log(`CLI-PID ${process.pid}`);\nsetInterval(() => {}, 1000);\n");
  const parent = spawn(electron, [fixture, 'ws', 'serve', 'x'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, HOME: path.join(testRoot, 'home'), ORION_BUNDLED_CLI_DIR: stubCli, ELECTRON_RUN_AS_NODE: '', ORION_DEV_USER_DATA: '' },
  });
  const cliPid = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`stub CLI never started: ${out}`)), 30_000);
    parent.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /CLI-PID (\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(cliPid));
  parent.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (alive(cliPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  const survived = alive(cliPid);
  if (survived) process.kill(cliPid, 'SIGKILL');
  assert.equal(survived, false, 'the CLI stops once the app process is killed');

  // A sign-in callback URL still starts the app.
  const url = run(['orion://auth/callback?code=abc']);
  assert.match(url.stdout, /APP-STARTED/);
} finally {
  await fs.rm(fixture, { force: true });
  await fs.rm(testRoot, { recursive: true, force: true });
}

console.log('test-cli-from-argv: ok');
