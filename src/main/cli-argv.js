// Whether this launch of the app binary is really a `durango-code` CLI call.
//
// The Linux packages install the app itself as /usr/bin/durango-code (the
// .deb/.pacman put /usr/bin/<package name> there, and the package is
// `durango-code`). That name wins on PATH over the bundled CLI launchers in
// <userData>/bin, so `durango-code ws new …` from an agent or a terminal
// started the desktop app, which found the running instance and quit: exit 0,
// no output, nothing done. run-cli-from-argv.js hands such calls to the
// bundled CLI instead.
//
// The command is the first CLI command word, after any leading options (the
// CLI parses options anywhere: `durango-code --json ws list`). An option may
// take the next argument as its value (`--path /repo status`). A plain
// positional before any command word (an orion:// URL from the desktop sign-in,
// a path) makes it an app launch, as do arguments with no command word at all
// (no arguments, Chromium switches, `.` in development). `--version` / `--help`
// count on their own.

/** cli/orion/src/index.ts: the `switch (command)` cases plus `git-credential`. */
export const CLI_COMMANDS = new Set([
  'activity',
  'approve',
  'bucket',
  'build',
  'change',
  'changes',
  'clone',
  'collaborator',
  'collaborators',
  'configure',
  'deploy',
  'deploys',
  'domain',
  'env',
  'environment',
  'git-credential',
  'land',
  'list',
  'login',
  'logout',
  'logs',
  'open',
  'plan',
  'pr',
  'preview',
  'projection',
  'projections',
  'pull',
  'pull-request',
  'repo',
  'repos',
  'resources',
  'run',
  'secret',
  'secrets',
  'service',
  'setup-git',
  'source',
  'status',
  'train',
  'whoami',
  'workspace',
  'ws',
]);

const CLI_FLAGS = new Set(['--version', '-v', '--help', '-h']);

/**
 * The CLI arguments when `argv` (process.argv) is a CLI call, else null.
 * `defaultApp` is process.defaultApp: `electron .` in development, where
 * argv[1] is the app path.
 */
export const cliArgsFromArgv = (argv, { defaultApp = false } = {}) => {
  const args = argv.slice(defaultApp ? 2 : 1);
  let cliFlag = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') return null;
    if (CLI_COMMANDS.has(arg)) return args;
    if (CLI_FLAGS.has(arg)) {
      cliFlag = true;
      continue;
    }
    if (!arg.startsWith('-')) return null;
    const next = args[index + 1];
    if (!arg.includes('=') && typeof next === 'string' && !next.startsWith('-') && !CLI_COMMANDS.has(next)) {
      index += 1;
    }
  }
  return cliFlag ? args : null;
};
