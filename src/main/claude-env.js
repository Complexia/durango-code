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

// Full access runs Claude Code with bypassPermissions, yet Claude Code still
// asks before some calls its own shell safety checks flag. Under Full access
// the person chose no prompts, and a thread a bot started has nobody watching
// it, so an ask there blocks it until someone happens to look (a bot's
// release thread waited 85 minutes on one). Full access approves those asks,
// and only those: Claude Code's permission callback carries no reason type
// (the SDK drops `decision_reason_type`), so a safety-check ask is recognized
// by its reason text. Each pattern below is a reason the real runtimes send
// (scripts/test-claude-safety-asks.mjs drives them):
//   - the shell parser couldn't be sure how bash/zsh reads the command
//     ("Claude Code can't be sure it read this command the way the shell
//     will, …", Claude Code 2.1.328+, e.g. `cd <repo>; declare -A M=(…); for
//     …; do git -C … ; done`),
//   - `cd` and `git` in one command, and the other bare-repository checks,
//   - the `&` background operator.
// Everything else still goes to the person: an ask a user's ask rule forced
// (no reason, or `matchedAskRule`), an ask a PreToolUse hook returned (its own
// reason), questions (AskUserQuestion), plan approval (ExitPlanMode), the
// checks that guard real removals ("Dangerous rm operation …", protected
// paths, shell -c scripts running rm), Claude settings files, and any reason
// not listed here.
const CLAUDE_SAFETY_CHECK_REASONS = [
  /^Claude Code can't be sure it read this command the way the shell will\b/,
  /^Compound commands with cd(?:\/Set-Location)? and git require\b/,
  /\bbare-repo indicators \(HEAD\/objects\/refs outside a \.git\/ directory\)/,
  /^The \.git file or symlink here redirects to a location\b/,
  /^This command uses the `&` background operator, which defers execution past approval-time safety checks\b/,
];
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Whether a canUseTool call is one of Claude Code's own shell safety-check asks (and nothing a user rule or hook forced). */
export const claudeSafetyCheckAsk = (toolName, options) => {
  if (!SHELL_TOOLS.has(toolName) || options?.matchedAskRule) return false;
  const reason = typeof options?.decisionReason === 'string' ? options.decisionReason.trim() : '';
  return Boolean(reason) && CLAUDE_SAFETY_CHECK_REASONS.some((pattern) => pattern.test(reason));
};

export const fullAccessApproves = (accessMode, toolName, options) =>
  accessMode === 'full-access' && claudeSafetyCheckAsk(toolName, options);
