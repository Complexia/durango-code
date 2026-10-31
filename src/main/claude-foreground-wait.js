// A foreground Bash call blocks the whole turn: the thread shows one frozen
// command until it exits, nobody can steer the agent meanwhile, and progress
// only appears at the end. Long waits (a deploy, a release, a long build or
// test run, a loop polling a log for a result) belong in the background with
// wait_for_background_tasks. The prompt says so; this PreToolUse hook makes it
// stick by refusing foreground calls that ask for a long timeout, with a reason
// that tells the agent how to rerun them. Blocking on a background task's
// output (TaskOutput with block) freezes the turn the same way, so it gets the
// same limit as a polling loop.

// Claude Code's own foreground default is 2 min; a call that asks for more than
// this expects to wait.
export const FOREGROUND_BASH_MAX_TIMEOUT_MS = 300_000;
// A loop that sleeps is a wait by construction, so it gets only the default.
export const FOREGROUND_POLL_MAX_TIMEOUT_MS = 120_000;

const POLLING_LOOP = /\b(?:for|while|until)\b[\s\S]*\bsleep\b/;

export const foregroundWaitRefusal = (toolInput) => {
  if (!toolInput || toolInput.run_in_background === true) return null;
  const timeout = Number(toolInput.timeout) || 0;
  const command = String(toolInput.command ?? '');
  const polls = POLLING_LOOP.test(command);
  const limit = polls ? FOREGROUND_POLL_MAX_TIMEOUT_MS : FOREGROUND_BASH_MAX_TIMEOUT_MS;
  if (timeout <= limit) return null;
  const what = polls
    ? `a foreground polling loop with a timeout over ${limit / 60_000} minutes`
    : `a foreground command with a timeout over ${limit / 60_000} minutes`;
  return [
    `Durango Code refused ${what}: it would block this thread with no progress and no way to steer you until it exits.`,
    'Run it again with run_in_background: true, then call mcp__orion__wait_for_background_tasks with the task id it prints; you are re-invoked when it finishes, and can check its output file meanwhile.',
    'Background the command that does the waiting itself (for deploys, `durango-code deploys --watch` exits once nothing is deploying), give any polling loop a stop condition, and keep only quick commands in the foreground.',
  ].join(' ');
};

export const taskOutputWaitRefusal = (toolInput) => {
  if (!toolInput || toolInput.block === false) return null;
  const timeout = Number(toolInput.timeout) || 0;
  if (timeout <= FOREGROUND_POLL_MAX_TIMEOUT_MS) return null;
  return [
    `Durango Code refused blocking on a background task for over ${FOREGROUND_POLL_MAX_TIMEOUT_MS / 60_000} minutes: it would block this thread with no progress and no way to steer you until the task finishes.`,
    'For a background command, call mcp__orion__wait_for_background_tasks with its task id instead; you are re-invoked when it finishes. For a background agent, end your turn or keep working; you are notified when it completes.',
    'To look at progress meanwhile, call TaskOutput with block: false or read its output file.',
  ].join(' ');
};

const REFUSALS = { Bash: foregroundWaitRefusal, TaskOutput: taskOutputWaitRefusal };

export const claudeForegroundWaitHooks = () => {
  const preToolUse = async (input) => {
    const reason = REFUSALS[input?.tool_name]?.(input.tool_input) ?? null;
    if (!reason) return { continue: true };
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  };
  return { PreToolUse: [{ matcher: 'Bash|TaskOutput', hooks: [preToolUse] }] };
};
