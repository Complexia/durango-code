import type { Message, NativeSubagentInfo, ProviderId, Thread, ThreadRecord, ThreadTranscript } from './store';

const INHERITED_SUBAGENT_CLOSE_TAG = '</inherited_subagent_transcript>';
const NEUTRALIZED_INHERITED_SUBAGENT_CLOSE_TAG = '<\u200b/inherited_subagent_transcript>';
export const INHERITED_SUBAGENT_TRANSCRIPT_MAX_CHARS = 80_000;

const cloneMessages = (messages: Message[]): Message[] =>
  messages.map((message) => ({
    ...message,
    status: message.status === 'running' ? 'stopped' : message.status,
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
    activities: message.activities?.map((activity) => ({
      ...activity,
      diff: activity.diff ? { ...activity.diff } : undefined,
      sources: activity.sources?.map((source) => ({ ...source })),
      plan: activity.plan?.map((entry) => ({ ...entry })),
    })),
    changedFiles: message.changedFiles?.map((file) => ({ ...file })),
    stats: message.stats ? { ...message.stats } : undefined,
    linkedTasks: message.linkedTasks?.map((task) => ({ ...task })),
  }));

// Codex collaboration children and Grok ACP subagents are backed by their own
// provider sessions. Other native providers expose a task/agent id whose
// transcript can be viewed but which their CLI cannot resume independently.
const resumableNativeSession = (
  subagent: NativeSubagentInfo | undefined
): Partial<Record<ProviderId, string>> => {
  if (!subagent || (subagent.providerId !== 'codex' && subagent.providerId !== 'grok')) {
    return {};
  }
  return { [subagent.providerId]: subagent.id };
};

const inheritedSessions = (thread: Thread): Partial<Record<ProviderId, string>> => ({
  ...resumableNativeSession(thread.subagent),
  ...thread.agentSessionIds,
});

const branchCopy = (
  source: Thread,
  messages: Message[],
  id: string,
  createdAt: string,
  parentThreadId?: string,
  inheritedChild = false
): ThreadRecord => {
  const agentSessionIds = inheritedSessions(source);
  const pendingForkProviders = Object.keys(agentSessionIds) as ProviderId[];
  return {
    id,
    projectId: source.projectId,
    title: inheritedChild ? source.title : `${source.title} (branch)`,
    status: inheritedChild ? source.status : 'idle',
    modelId: source.modelId,
    accessMode: source.accessMode,
    mcpServerIds: source.mcpServerIds ? [...source.mcpServerIds] : undefined,
    codexReasoningEffort: source.codexReasoningEffort,
    codexServiceTier: source.codexServiceTier,
    claudeReasoningEffort: source.claudeReasoningEffort,
    claudeContextWindow: source.claudeContextWindow,
    grokReasoningEffort: source.grokReasoningEffort,
    museReasoningEffort: source.museReasoningEffort,
    openCodeReasoningEffort: source.openCodeReasoningEffort,
    createdAt,
    // A new branch is a top-level Recent entry even when its source was a
    // hidden child (or had previously been removed from Recent).
    hiddenFromRecent: parentThreadId ? true : undefined,
    messages: cloneMessages(messages),
    // Goals live in a provider session, and /btw answers are detached asides,
    // so both intentionally reset just as they did for a single-thread branch.
    agentSessionIds: pendingForkProviders.length ? agentSessionIds : undefined,
    pendingForkProviders: pendingForkProviders.length ? pendingForkProviders : undefined,
    branchedFromThreadId: source.id,
    parentThreadId,
    // A copied native transcript is no longer a live mirror. Keeping its
    // origin preserves the useful role/model label while allowing the branch
    // to select a model and send follow-up turns like any Orion subagent.
    inheritedSubagent: source.subagent ?? source.inheritedSubagent,
    // Forked sessions are recorded under the source's cwd, so a branch keeps
    // working in the source thread's Durango workspace (or its project).
    durangoWorkspace: source.durangoWorkspace,
  };
};

export type ThreadBranchFamily = {
  rootId: string;
  threads: ThreadRecord[];
};

/**
 * A copied child can be continued on a different provider, where it has no
 * session to fork. Supply its visible conversation to that first fresh turn
 * so changing models does not silently discard the inherited work.
 */
export const inheritedSubagentResumeContext = (
  thread: Thread,
  messages: Message[],
  providerId: ProviderId
): string | null => {
  const isInheritedChild = Boolean(
    thread.inheritedSubagent || (thread.parentThreadId && thread.branchedFromThreadId)
  );
  if (!isInheritedChild || thread.agentSessionIds?.[providerId]) return null;

  let transcript = messages
    .map((message) => {
      const content = message.content
        .trim()
        .split(INHERITED_SUBAGENT_CLOSE_TAG)
        .join(NEUTRALIZED_INHERITED_SUBAGENT_CLOSE_TAG);
      if (!content) return null;
      const role = message.role === 'agent' ? 'Assistant' : message.role === 'user' ? 'User' : 'System';
      return `${role}: ${content}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join('\n\n');
  if (!transcript) return null;
  if (transcript.length > INHERITED_SUBAGENT_TRANSCRIPT_MAX_CHARS) {
    const truncationNote = 'Earlier transcript content was omitted to fit the context limit.\n\n';
    transcript = `${truncationNote}${transcript.slice(
      -(INHERITED_SUBAGENT_TRANSCRIPT_MAX_CHARS - truncationNote.length)
    )}`;
  }

  return [
    'This is the preserved conversation from a completed subagent instance inherited by a thread branch. Continue from this work using the new instruction after the transcript.',
    '<inherited_subagent_transcript>',
    transcript,
    INHERITED_SUBAGENT_CLOSE_TAG,
  ].join('\n');
};

export const prependInheritedSubagentResumeContext = (
  thread: Thread,
  messages: Message[],
  providerId: ProviderId,
  prompt: string
): string => {
  const inheritedContext = inheritedSubagentResumeContext(thread, messages, providerId);
  if (!inheritedContext) return prompt;
  return prompt ? `${inheritedContext}\n\n${prompt}` : inheritedContext;
};

// A copied child must have settled: its last run finished and the thread
// isn't running. Live descendants are still changing, so there is no stable
// completed instance to inherit.
const isSettledChild = (child: Thread) => {
  const lastRun = child.summary.lastAgentRun;
  return child.status !== 'running' && Boolean(lastRun) && lastRun!.status !== 'running';
};

const childrenByParentOf = (threads: Thread[]) => {
  const childrenByParent = new Map<string, Thread[]>();
  for (const thread of threads) {
    // A thread on another machine an agent started (machine_run_agent) has
    // its context there; a copy here would be a local thread without it.
    if (!thread.parentThreadId || thread.remote) continue;
    const children = childrenByParent.get(thread.parentThreadId);
    if (children) children.push(thread);
    else childrenByParent.set(thread.parentThreadId, [thread]);
  }
  return childrenByParent;
};

/** The threads a branch of `sourceThreadId` copies: it and its settled subagents. */
export const branchFamilyThreadIds = (threads: Thread[], sourceThreadId: string): string[] => {
  if (!threads.some((thread) => thread.id === sourceThreadId)) return [];
  const childrenByParent = childrenByParentOf(threads);
  const ids = [sourceThreadId];
  const seen = new Set(ids);
  const visit = (parentId: string) => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (seen.has(child.id) || !isSettledChild(child)) continue;
      seen.add(child.id);
      ids.push(child.id);
      visit(child.id);
    }
  };
  visit(sourceThreadId);
  return ids;
};

/**
 * Clone a thread plus its settled subagent hierarchy. Live descendants are
 * deliberately excluded: their transcripts and sessions are still changing,
 * so there is no stable completed instance to inherit. Needs the transcripts
 * of branchFamilyThreadIds; null when the source's isn't loaded, and a child
 * whose transcript isn't loaded is left out.
 */
export const createThreadBranchFamily = (
  threads: Thread[],
  transcripts: Record<string, ThreadTranscript | undefined>,
  sourceThreadId: string,
  createId: () => string = () => crypto.randomUUID(),
  now: () => string = () => new Date().toISOString()
): ThreadBranchFamily | null => {
  const source = threads.find((thread) => thread.id === sourceThreadId);
  const sourceTranscript = transcripts[sourceThreadId];
  if (!source || !sourceTranscript) return null;

  const rootId = createId();
  const root = branchCopy(source, sourceTranscript.messages, rootId, now());
  const childrenByParent = childrenByParentOf(threads);

  const copies: ThreadRecord[] = [root];
  const seen = new Set<string>([source.id]);
  const copyChildren = (sourceParentId: string, copiedParent: ThreadRecord) => {
    for (const child of childrenByParent.get(sourceParentId) ?? []) {
      const childTranscript = transcripts[child.id];
      if (seen.has(child.id) || !isSettledChild(child) || !childTranscript) continue;
      seen.add(child.id);
      const childId = createId();
      const copiedChild = branchCopy(
        child,
        childTranscript.messages,
        childId,
        child.createdAt,
        copiedParent.id,
        true
      );
      copies.push(copiedChild);
      copyChildren(child.id, copiedChild);
    }
  };
  copyChildren(source.id, root);

  return { rootId, threads: copies };
};
