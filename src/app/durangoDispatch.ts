import type { Thread } from '../store';

// Renderer side of Durango Chat dispatch (main: src/main/durango-dispatch.js).

export const DISPATCH_SUMMARY_MAX_CHARS = 2_000;

/** The end of a long final response is where agents put their conclusion. */
export const dispatchSummaryText = (content: string, max = DISPATCH_SUMMARY_MAX_CHARS) => {
  const text = content.trim();
  if (text.length <= max) return text;
  return `…${text.slice(-(max - 1)).trimStart()}`;
};

/**
 * How a dispatched thread's run ended, or null while it is still running (or
 * has not started). Only the dispatched run counts: the thread's first run,
 * or for a follow-up dispatch the run at `runOffset` (the runs it already had).
 * Later turns are the user's own.
 */
export const durangoDispatchOutcome = (
  thread: Pick<Thread, 'status' | 'messages' | 'durangoDispatch'>
): { outcome: 'finished'; summary: string } | { outcome: 'failed'; error: string } | null => {
  const dispatch = thread.durangoDispatch;
  if (!dispatch || dispatch.reportedAt) return null;
  if (thread.status === 'running') return null;
  const runs = thread.messages.filter((message) => message.role === 'agent' && message.kind === 'agent-run');
  // The run message exists before `durangoDispatch` is stamped, so take the
  // run by position rather than filtering by time.
  const run = runs[dispatch.runOffset ?? 0] ?? null;
  if (!run) {
    // Start failures before any run message (rare): report the thread error.
    if (thread.status === 'error') return { outcome: 'failed', error: 'The agent failed to start.' };
    return null;
  }
  if (run.status === 'running') return null;
  if (run.status === 'error' || (thread.status === 'error' && run.status !== 'done')) {
    return {
      outcome: 'failed',
      error: (run.error || run.statusText || 'The agent stopped with an error.').trim(),
    };
  }
  if (run.status === 'stopped') {
    return {
      outcome: 'failed',
      error:
        run.statusText && /restart/i.test(run.statusText)
          ? 'Durango Code quit before the agent finished.'
          : 'Stopped in Durango Code before it finished.',
    };
  }
  if (run.status === 'done') {
    const summary = dispatchSummaryText(run.content || '');
    return { outcome: 'finished', summary: summary || 'The agent finished without a written summary.' };
  }
  return null;
};

/** What main needs from each project to register this Mac (repo ids are read in main). */
export const dispatchProjectsPayload = (projects: Array<{ id: string; name: string; path: string }>) =>
  projects.map((project) => ({ id: project.id, name: project.name, path: project.path }));
