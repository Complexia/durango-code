// Claude Code gates its own Claude in Chrome tools (mcp__claude-in-chrome__*)
// behind the auto-mode permission classifier even when the session runs with
// --dangerously-skip-permissions / permissionMode bypassPermissions. The CLI
// calls this the "chrome classifier floor"; it is switched on remotely
// (feature flag tengu_cowork_chrome_automode_default) and surfaces to the
// agent as "denied by the Claude Code auto mode classifier" on browser
// actions such as typing into a page. Orion must never expose fewer
// capabilities than Claude Code itself, and Orion's access modes already
// decide whether browser tools are available, so every claude process Orion
// launches opts out of the floor through the CLI's env override. An explicit
// value already present in the environment wins so a user can opt back in.
export const CLAUDE_CHROME_CLASSIFIER_FLOOR_ENV = 'CLAUDE_CHROME_CLASSIFIER_FLOOR';

export const withClaudeEnv = (env = process.env) => ({
  [CLAUDE_CHROME_CLASSIFIER_FLOOR_ENV]: 'false',
  ...env,
});

// How a Durango Code access mode runs Claude Code (agent threads and bot
// replies alike): Full access skips permission prompts, Workspace write
// accepts edits and asks for the rest, Read only plans without changing files.
export const claudePermissionOptionsForAccessMode = (accessMode) =>
  accessMode === 'full-access'
    ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
    : { permissionMode: accessMode === 'read-only' ? 'plan' : 'acceptEdits' };
