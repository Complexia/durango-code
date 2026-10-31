import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  FOREGROUND_BASH_MAX_TIMEOUT_MS,
  FOREGROUND_POLL_MAX_TIMEOUT_MS,
  claudeForegroundWaitHooks,
  foregroundWaitRefusal,
  taskOutputWaitRefusal,
} from '../src/main/claude-foreground-wait.js';

// The call that motivated this: retry a deploy, then poll its log for ~9 min in the foreground.
const deployWait = {
  command:
    'L=$(durango-code deploys retry create-sandbox 2>&1 | grep -oE "/Users/[^ ]*\\.log"); for i in $(seq 1 110); do grep -qE "create-sandbox: (live|deploy failed)" "$L" && break; sleep 5; done',
  timeout: 660_000,
};
assert.match(foregroundWaitRefusal(deployWait), /polling loop/);
assert.equal(foregroundWaitRefusal({ ...deployWait, run_in_background: true }), null, 'the same wait in the background is fine');

// Polling loops get the default timeout; other commands get up to 5 minutes.
assert.equal(foregroundWaitRefusal({ ...deployWait, timeout: FOREGROUND_POLL_MAX_TIMEOUT_MS }), null);
assert.equal(foregroundWaitRefusal({ ...deployWait, timeout: undefined }), null, 'no timeout means the 2 min default');
assert.match(foregroundWaitRefusal({ command: 'until curl -sf localhost:3000; do sleep 2; done', timeout: 180_000 }), /polling loop/);
assert.equal(foregroundWaitRefusal({ command: 'bun run typecheck', timeout: 180_000 }), null);
assert.equal(foregroundWaitRefusal({ command: 'bun run typecheck', timeout: FOREGROUND_BASH_MAX_TIMEOUT_MS }), null);
assert.match(
  foregroundWaitRefusal({ command: 'bun run deploy', timeout: FOREGROUND_BASH_MAX_TIMEOUT_MS + 1 }),
  /foreground command with a timeout over 5 minutes/
);
assert.equal(foregroundWaitRefusal(undefined), null);

// The reason tells the agent how to rerun it.
const reason = foregroundWaitRefusal(deployWait);
assert.match(reason, /run_in_background: true/);
assert.match(reason, /mcp__orion__wait_for_background_tasks/);
assert.match(reason, /deploys --watch/);

// Blocking on a background task's output is a foreground wait too.
const taskWait = { task_id: 'b60hr24pa', block: true, timeout: 300_000 };
assert.match(taskOutputWaitRefusal(taskWait), /mcp__orion__wait_for_background_tasks/);
assert.equal(taskOutputWaitRefusal({ ...taskWait, block: false }), null, 'peeking at output is fine');
assert.equal(taskOutputWaitRefusal({ ...taskWait, timeout: FOREGROUND_POLL_MAX_TIMEOUT_MS }), null);
assert.equal(taskOutputWaitRefusal({ task_id: 'b60hr24pa', block: true }), null, 'no timeout means the short default');
assert.equal(taskOutputWaitRefusal(undefined), null);

// The hook denies only refused Bash and TaskOutput calls.
{
  const hooks = claudeForegroundWaitHooks();
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash|TaskOutput');
  const preToolUse = hooks.PreToolUse[0].hooks[0];
  const denied = await preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: deployWait });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(denied.hookSpecificOutput.permissionDecisionReason, reason);
  assert.deepEqual(await preToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' } }), { continue: true });
  const taskDenied = await preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'TaskOutput', tool_input: taskWait });
  assert.equal(taskDenied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(taskDenied.hookSpecificOutput.permissionDecisionReason, taskOutputWaitRefusal(taskWait));
  assert.deepEqual(await preToolUse({ tool_name: 'TaskOutput', tool_input: { ...taskWait, block: false } }), { continue: true });
  assert.deepEqual(await preToolUse({ tool_name: 'Read', tool_input: { timeout: 900_000 } }), { continue: true });
}

// Every SDK session gets the hook, with or without Chrome.
const driverSource = await fs.readFile(new URL('../src/main/claude-driver.js', import.meta.url), 'utf8');
assert.match(driverSource, /hooks: mergeClaudeHooks\(\n\s+claudeForegroundWaitHooks\(\),/);

console.log('claude foreground wait tests passed');
