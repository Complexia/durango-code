// Claude in Chrome (--chrome) runs every Claude session through one extension
// and one browser window. Concurrent sessions each get their own tab group, but
// they still share the extension's connection and fight over which tab is in
// front. Claude Code checks the target tab's URL before every tab-bound action
// with a fixed 5 s bridge timeout, and a slow bridge turns that check into
// "Couldn't determine which page this action targets" before anything runs.
// Orion therefore serializes Chrome use across its Claude threads through a
// lease, and appends usage tips that keep one agent from wedging the page.

export const CLAUDE_CHROME_TOOL_PREFIX = 'mcp__claude-in-chrome__';

export const CLAUDE_CHROME_BROWSER_TIPS = [
  '# Claude in Chrome (Durango Code)',
  'Other Durango Code threads may share this Chrome. Durango Code holds a browser call while another thread is using Chrome, so a call can take longer to start.',
  '- "Couldn\'t determine which page this action targets" means the action did not run. Call tabs_context_mcp, then repeat the identical call once. Do not open or close tabs to recover.',
  '- Never close the last tab in your tab group while recovering; closing it loses the group. Navigate an existing tab instead.',
  '- Never type more than a few hundred characters with computer type: per-key input can freeze the page. Set editor or field contents with javascript_tool (for example through the editor\'s own API or its React change handler) and verify the length afterwards.',
].join('\n');

// A holder keeps the lease while it has a browser call in flight, or while its
// turn is still running and it used Chrome within this window.
export const CLAUDE_CHROME_LEASE_IDLE_MS = 60_000;
// A waiter gives up and proceeds (with a warning) after this long.
export const CLAUDE_CHROME_LEASE_MAX_WAIT_MS = 120_000;
// A call whose Post hook never arrived (interrupted tool) stops counting after this.
export const CLAUDE_CHROME_STALE_CALL_MS = 90_000;
const POLL_MS = 500;

export const isClaudeChromeTool = (toolName) =>
  typeof toolName === 'string' && toolName.startsWith(CLAUDE_CHROME_TOOL_PREFIX);

// holder: { threadId, isAlive(): boolean, isActive(): boolean, lastUsedAt, calls: Map<toolUseId, startedAt> }
let lease = null;
const waiters = []; // threadIds in arrival order

const liveCallCount = (holder, now) => {
  let count = 0;
  for (const startedAt of holder.calls.values()) {
    if (now - startedAt < CLAUDE_CHROME_STALE_CALL_MS) count += 1;
  }
  return count;
};

const leaseValid = (now) =>
  Boolean(lease) &&
  lease.isAlive() &&
  (liveCallCount(lease, now) > 0 ||
    (lease.isActive() && now - lease.lastUsedAt < CLAUDE_CHROME_LEASE_IDLE_MS));

const leaseHeldByOther = (threadId, now) => leaseValid(now) && lease.threadId !== threadId;

const takeLease = (threadId, isAlive, isActive, toolUseId, now) => {
  // A replacement SDK session can reuse the thread id. Discard the dead
  // session's unfinished calls before installing the new liveness callback.
  if (!lease || lease.threadId !== threadId || !lease.isAlive()) {
    lease = { threadId, isAlive, isActive, lastUsedAt: now, calls: new Map() };
  }
  lease.isAlive = isAlive;
  lease.isActive = isActive;
  lease.lastUsedAt = now;
  if (toolUseId) lease.calls.set(toolUseId, now);
};

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

// Resolves once this thread may drive Chrome. Returns how long it waited and
// whether it gave up without the lease. Waiters are served in arrival order.
export const acquireClaudeChromeLease = async ({
  threadId,
  isAlive = () => true,
  isActive,
  toolUseId,
  signal,
  onWait,
  maxWaitMs = CLAUDE_CHROME_LEASE_MAX_WAIT_MS,
  pollMs = POLL_MS,
}) => {
  const startedAt = Date.now();
  const firstInLine = () => waiters[0] === threadId || !waiters.includes(threadId);
  // In-flight calls keep Chrome even between foreground turns. With no calls,
  // the active turn's idle grace applies; a free Chrome goes to queued threads.
  const holdsLease = leaseValid(startedAt) && lease.threadId === threadId;
  if (holdsLease || (!leaseHeldByOther(threadId, startedAt) && waiters.length === 0)) {
    takeLease(threadId, isAlive, isActive, toolUseId, startedAt);
    return { waitedMs: 0, timedOut: false, aborted: false };
  }
  if (!waiters.includes(threadId)) waiters.push(threadId);
  let notified = false;
  try {
    for (;;) {
      const now = Date.now();
      if (signal?.aborted) return { waitedMs: now - startedAt, timedOut: false, aborted: true };
      if (!leaseHeldByOther(threadId, now) && firstInLine()) {
        takeLease(threadId, isAlive, isActive, toolUseId, now);
        return { waitedMs: now - startedAt, timedOut: false, aborted: false };
      }
      if (now - startedAt >= maxWaitMs) {
        return { waitedMs: now - startedAt, timedOut: true, aborted: false };
      }
      if (!notified) {
        notified = true;
        onWait?.();
      }
      await sleep(pollMs, signal);
    }
  } finally {
    const index = waiters.indexOf(threadId);
    if (index !== -1) waiters.splice(index, 1);
  }
};

export const releaseClaudeChromeCall = (threadId, toolUseId, now = Date.now()) => {
  if (!lease || lease.threadId !== threadId) return;
  if (toolUseId) lease.calls.delete(toolUseId);
  lease.lastUsedAt = now;
};

export const resetClaudeChromeLeaseForTests = () => {
  lease = null;
  waiters.length = 0;
};

// SDK hooks for one Orion Claude session. PreToolUse runs even in
// bypassPermissions mode, so it gates every Claude in Chrome call.
export const claudeChromeLeaseHooks = (session, { emitActivity } = {}) => {
  const isAlive = () => !session.ended && !session.disposed;
  const isActive = () => session.activeTurns.length > 0;
  const preToolUse = async (input, toolUseId, { signal } = {}) => {
    if (!isClaudeChromeTool(input?.tool_name)) return { continue: true };
    const id = toolUseId ?? input.tool_use_id;
    const key = `chrome-lease-${id}`;
    let waitShown = false;
    const result = await acquireClaudeChromeLease({
      threadId: session.threadId,
      isAlive,
      isActive,
      toolUseId: id,
      signal,
      onWait: () => {
        waitShown = true;
        emitActivity?.({
          key,
          type: 'tool',
          title: 'Waiting for Chrome',
          detail: 'Another Durango Code thread is using Chrome. This browser call starts when it is done.',
          status: 'running',
        });
      },
    });
    const seconds = Math.round(result.waitedMs / 1000);
    if (waitShown) {
      emitActivity?.({
        key,
        type: 'tool',
        title: result.timedOut ? 'Chrome still busy' : 'Waited for Chrome',
        detail: result.timedOut
          ? `Another Durango Code thread kept using Chrome for ${seconds}s. Proceeding anyway.`
          : `Another Durango Code thread was using Chrome; waited ${seconds}s.`,
        status: 'done',
      });
    }
    if (result.aborted) return { continue: true };
    if (result.timedOut) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `Another Durango Code thread has been using this Chrome for over ${seconds}s and is still active. Browser calls may be slow or be refused with "Couldn't determine which page this action targets"; retry the identical call once after tabs_context_mcp, and keep to your own tab group.`,
        },
      };
    }
    if (seconds > 0) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `Durango Code held this call for ${seconds}s while another Durango Code thread used Chrome. The browser may have changed focus; take a fresh screenshot before relying on earlier coordinates.`,
        },
      };
    }
    return { continue: true };
  };
  const postToolUse = async (input, toolUseId) => {
    if (isClaudeChromeTool(input?.tool_name)) {
      releaseClaudeChromeCall(session.threadId, toolUseId ?? input.tool_use_id);
    }
    return { continue: true };
  };
  const matcher = `^${CLAUDE_CHROME_TOOL_PREFIX}`;
  // The hook timeout (seconds) must outlast the longest lease wait.
  const timeout = Math.ceil(CLAUDE_CHROME_LEASE_MAX_WAIT_MS / 1000) + 60;
  return {
    PreToolUse: [{ matcher, hooks: [preToolUse], timeout }],
    PostToolUse: [{ matcher, hooks: [postToolUse] }],
    PostToolUseFailure: [{ matcher, hooks: [postToolUse] }],
    // A denied call never runs, so no Post hook follows it.
    PermissionDenied: [{ matcher, hooks: [postToolUse] }],
  };
};
