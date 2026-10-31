import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  CLAUDE_CHROME_BROWSER_TIPS,
  CLAUDE_CHROME_LEASE_IDLE_MS,
  acquireClaudeChromeLease,
  claudeChromeLeaseHooks,
  isClaudeChromeTool,
  releaseClaudeChromeCall,
  resetClaudeChromeLeaseForTests,
} from '../src/main/claude-chrome.js';

const fakeSession = (threadId) => ({ threadId, ended: false, disposed: false, activeTurns: [{ runId: `${threadId}-run` }] });
const chromeInput = (id, tool = 'mcp__claude-in-chrome__computer') => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: id });

assert.equal(isClaudeChromeTool('mcp__claude-in-chrome__browser_batch'), true);
assert.equal(isClaudeChromeTool('Bash'), false);
assert.match(CLAUDE_CHROME_BROWSER_TIPS, /Couldn't determine which page this action targets/);
assert.match(CLAUDE_CHROME_BROWSER_TIPS, /tabs_context_mcp/);
assert.match(CLAUDE_CHROME_BROWSER_TIPS, /last tab/);
assert.match(CLAUDE_CHROME_BROWSER_TIPS, /javascript_tool/);

// Non-Chrome tools pass straight through.
resetClaudeChromeLeaseForTests();
{
  const hooks = claudeChromeLeaseHooks(fakeSession('a'));
  assert.deepEqual(await hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash' }, 'x', {}), { continue: true });
  assert.ok(hooks.PreToolUse[0].timeout > 120, 'the hook timeout outlasts the longest lease wait');
  assert.ok(new RegExp(hooks.PreToolUse[0].matcher).test('mcp__claude-in-chrome__navigate'));
}

// Background calls remain protected both when they start between foreground
// turns and when their foreground turn ends before the call completes.
for (const startsBetweenTurns of [true, false]) {
  for (const completion of ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
    resetClaudeChromeLeaseForTests();
    const owner = fakeSession('background');
    if (startsBetweenTurns) owner.activeTurns = [];
    const hooks = claudeChromeLeaseHooks(owner);
    await hooks.PreToolUse[0].hooks[0](chromeInput('background-call'), 'background-call', {});
    owner.activeTurns = [];
    const blocked = await acquireClaudeChromeLease({
      threadId: 'foreground', isActive: () => true, toolUseId: 'foreground-call',
      maxWaitMs: 30, pollMs: 5,
    });
    assert.equal(blocked.timedOut, true, 'an in-flight background call still holds Chrome without a foreground turn');
    await hooks[completion][0].hooks[0](chromeInput('background-call'), 'background-call', {});
    const released = await acquireClaudeChromeLease({
      threadId: 'foreground', isActive: () => true, toolUseId: 'next-call',
      maxWaitMs: 30, pollMs: 5,
    });
    assert.equal(released.timedOut, false, `${completion} releases a background call`);
    assert.equal(released.waitedMs, 0, 'an idle background owner does not retain the foreground grace period');
  }
}

// Session teardown must still release an unfinished call immediately.
for (const terminalState of ['ended', 'disposed']) {
  resetClaudeChromeLeaseForTests();
  const owner = fakeSession('owner');
  const hooks = claudeChromeLeaseHooks(owner);
  await hooks.PreToolUse[0].hooks[0](chromeInput('unfinished'), 'unfinished', {});
  owner[terminalState] = true;
  const released = await acquireClaudeChromeLease({
    threadId: 'next', isActive: () => true, toolUseId: 'next-call',
    maxWaitMs: 30, pollMs: 5,
  });
  assert.equal(released.timedOut, false, `${terminalState} sessions cannot retain Chrome`);
  assert.equal(released.waitedMs, 0);
}

// Restarting the same thread must discard unfinished calls from its old
// session while retaining protection for the replacement session's calls.
for (const terminalState of ['ended', 'disposed']) {
  resetClaudeChromeLeaseForTests();
  const previous = fakeSession('restarted');
  const previousHooks = claudeChromeLeaseHooks(previous);
  await previousHooks.PreToolUse[0].hooks[0](chromeInput('interrupted'), 'interrupted', {});
  previous[terminalState] = true;

  const replacement = fakeSession('restarted');
  const replacementHooks = claudeChromeLeaseHooks(replacement);
  await replacementHooks.PreToolUse[0].hooks[0](chromeInput('replacement-call'), 'replacement-call', {});
  replacement.activeTurns = [];
  const contender = {
    threadId: 'other', isActive: () => true, toolUseId: 'other-call',
    maxWaitMs: 30, pollMs: 5,
  };
  assert.equal((await acquireClaudeChromeLease(contender)).timedOut, true,
    'the replacement session still holds Chrome during its own call');
  await replacementHooks.PostToolUse[0].hooks[0](chromeInput('replacement-call'), 'replacement-call', {});
  const released = await acquireClaudeChromeLease(contender);
  assert.equal(released.timedOut, false, `unfinished calls from an ${terminalState} session must not survive replacement`);
  assert.equal(released.waitedMs, 0, 'the replacement releases Chrome as soon as its own work finishes');
}

// A second thread waits while the first has a call in flight, then proceeds
// with context once the call ends and the first thread's turn finishes.
resetClaudeChromeLeaseForTests();
{
  const a = fakeSession('a');
  const b = fakeSession('b');
  const activitiesB = [];
  const hooksA = claudeChromeLeaseHooks(a);
  const hooksB = claudeChromeLeaseHooks(b, { emitActivity: (activity) => activitiesB.push(activity) });
  assert.deepEqual(await hooksA.PreToolUse[0].hooks[0](chromeInput('a1'), 'a1', {}), { continue: true });
  let bDone = false;
  const bResult = hooksB.PreToolUse[0].hooks[0](chromeInput('b1'), 'b1', {}).then((result) => {
    bDone = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(bDone, false, 'thread b waits while thread a has a Chrome call in flight');
  assert.equal(activitiesB[0]?.status, 'running');
  // Thread a keeps Chrome while it is active, even with b queued.
  assert.deepEqual(await hooksA.PreToolUse[0].hooks[0](chromeInput('a2'), 'a2', {}), { continue: true });
  await hooksA.PostToolUse[0].hooks[0](chromeInput('a1'), 'a1', {});
  await hooksA.PostToolUseFailure[0].hooks[0](chromeInput('a2'), 'a2', {});
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(bDone, false, 'recent use by an active turn still holds the lease');
  a.activeTurns = [];
  const result = await bResult;
  assert.match(result.hookSpecificOutput.additionalContext, /held this call/);
  assert.equal(activitiesB.at(-1).status, 'done');
  assert.equal(activitiesB.at(-1).key, activitiesB[0].key);
  // Now b holds it, and a new call from a must wait.
  a.activeTurns = [{ runId: 'a-run-2' }];
  const controller = new AbortController();
  const aWait = hooksA.PreToolUse[0].hooks[0](chromeInput('a3'), 'a3', { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 600));
  controller.abort();
  assert.deepEqual(await aWait, { continue: true }, 'an interrupted wait lets the SDK cancel the call');
}

// Idle expiry, timeouts, and ended holders.
resetClaudeChromeLeaseForTests();
{
  await acquireClaudeChromeLease({ threadId: 'x', isActive: () => true, toolUseId: 'x1' });
  releaseClaudeChromeCall('x', 'x1', Date.now() - CLAUDE_CHROME_LEASE_IDLE_MS - 1);
  const idle = await acquireClaudeChromeLease({ threadId: 'y', isActive: () => true, toolUseId: 'y1', pollMs: 20 });
  assert.equal(idle.waitedMs, 0, 'an idle holder does not block others');
  const timedOut = await acquireClaudeChromeLease({ threadId: 'z', isActive: () => true, toolUseId: 'z1', maxWaitMs: 100, pollMs: 20 });
  assert.equal(timedOut.timedOut, true, 'a waiter proceeds without the lease after the max wait');
  resetClaudeChromeLeaseForTests();
  await acquireClaudeChromeLease({ threadId: 'y', isActive: () => false, toolUseId: 'y2' });
  releaseClaudeChromeCall('y', 'y2');
  const ended = await acquireClaudeChromeLease({ threadId: 'z', isActive: () => true, toolUseId: 'z2', pollMs: 20 });
  assert.equal(ended.waitedMs, 0, 'a holder whose turn and browser calls ended does not block others');
  assert.ok(claudeChromeLeaseHooks(fakeSession('z')).PermissionDenied, 'denied calls release their slot');
}

const driverSource = await fs.readFile(new URL('../src/main/claude-driver.js', import.meta.url), 'utf8');
assert.match(driverSource, /chromeEnabled \? \[CLAUDE_CHROME_BROWSER_TIPS\]/, 'SDK sessions with Chrome get the browser tips');
assert.match(driverSource, /chromeEnabled\n\s+\? claudeChromeLeaseHooks\(session/, 'SDK sessions with Chrome take the cross-thread lease');
const commandSource = await fs.readFile(new URL('../src/main/command-for-model.js', import.meta.url), 'utf8');
assert.match(commandSource, /\['--chrome', '--append-system-prompt', CLAUDE_CHROME_BROWSER_TIPS\]/, 'one-shot Chrome runs get the browser tips');

console.log('Claude Chrome tests passed');
