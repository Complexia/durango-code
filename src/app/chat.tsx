import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Brain, Check, ChevronDown, ChevronRight, CircleCheck, Copy, Sparkles, SquareKanban, Terminal, X, Zap } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { isNoProjectId, type BtwExchange, type LinkedBoardTask, type Message, type Thread, useOrionStore } from '../store';
import type { AgentModel } from '../agentCatalog';
import { SessionImportCard } from './SessionImport';
import { agentProviders } from '../agentCatalog';
import { AgentActivityCard, buildAgentRunSegments, FloatingTasksCard, formatRunDuration, formatTokenCount, useRunTicker } from './activity';
import { AttachmentThumb } from './attachments';
import {
  MarkdownBaseDirContext,
  MarkdownContent,
  StreamingMarkdownContent,
  ThreadReferenceText,
} from './markdown';
import { linkedTaskStatusLabel } from './promptContext';
import { workStartedAt } from './threadLists';

export const CopyMessageButton: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied; nothing to surface.
    }
  };

  return (
    <button
      type="button"
      className={`message-copy-btn${copied ? ' copied' : ''}${className ? ` ${className}` : ''}`}
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
};

const AGENT_SWITCHER_VISIBLE_LIMIT = 5;

// Claude Code-style agents switcher. When the current thread's family (the
// main run plus every subagent it spawned — provider-native or Orion-spawned)
// has members, a strip above the composer lists them with live status, so the
// user can flip between transcripts without losing their place. It renders
// identically on the main thread and on every subagent thread; only the
// highlighted row changes, which is what makes switching back and forth
// seamless.
export const AgentFamilySwitcher: React.FC<{
  currentThread: Thread;
  threads: Thread[];
  onSelect: (threadId: string) => void;
  /** True when the composer lives in a split pane. Panes are short on room,
      so the strip starts collapsed and the open list overlays the transcript
      (positioned by the pane CSS) rather than taking composer space. */
  split?: boolean;
}> = ({ currentThread, threads, onSelect, split = false }) => {
  const [expandedRootId, setExpandedRootId] = useState<string | null>(null);
  // Whole strip open/closed — independent of the "show N more" list truncation.
  // null = untouched by the user: open in the full view, closed in a split pane.
  const [sectionOpenState, setSectionOpenState] = useState<boolean | null>(null);
  const sectionOpen = sectionOpenState ?? !split;

  // In a split pane the open list overlays the transcript, growing upward from
  // the strip. Cap it at the pane top so its own scrollbar can always reach
  // the last row; remeasure when the pane or the composer changes height.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [overlayMaxHeight, setOverlayMaxHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!split || !sectionOpen) return undefined;
    const wrap = wrapRef.current;
    const pane = wrap?.closest('.panel-content');
    if (!wrap || !pane) return undefined;
    const measure = () => {
      setOverlayMaxHeight(
        Math.max(0, wrap.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12)
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(wrap.parentElement ?? wrap);
    return () => observer.disconnect();
  }, [split, sectionOpen]);

  // Walk up to the family root — subagents can themselves spawn subagents.
  const root = useMemo(() => {
    let node = currentThread;
    const seen = new Set<string>([node.id]);
    while (node.parentThreadId) {
      const parent = threads.find((t) => t.id === node.parentThreadId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      node = parent;
    }
    return node;
  }, [currentThread, threads]);

  const subagents = useMemo(() => {
    const childrenByParent = new Map<string, Thread[]>();
    for (const thread of threads) {
      if (!thread.parentThreadId) continue;
      const siblings = childrenByParent.get(thread.parentThreadId);
      if (siblings) siblings.push(thread);
      else childrenByParent.set(thread.parentThreadId, [thread]);
    }
    for (const children of childrenByParent.values()) {
      children.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    }

    const seen = new Set<string>([root.id]);
    const collect = (
      parentId: string,
      depth: number,
      out: Array<{ thread: Thread; depth: number }>
    ) => {
      for (const child of childrenByParent.get(parentId) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push({ thread: child, depth });
        collect(child.id, depth + 1, out);
      }
    };
    const out: Array<{ thread: Thread; depth: number }> = [];
    collect(root.id, 0, out);
    return out;
  }, [threads, root.id]);

  const isExpanded = expandedRootId === root.id;
  const visibleSubagents = useMemo(() => {
    if (isExpanded || subagents.length <= AGENT_SWITCHER_VISIBLE_LIMIT) return subagents;

    const firstSubagents = subagents.slice(0, AGENT_SWITCHER_VISIBLE_LIMIT);
    const currentSubagent = subagents.find(({ thread }) => thread.id === currentThread.id);
    if (!currentSubagent || firstSubagents.includes(currentSubagent)) return firstSubagents;

    // Keep the selected row visible even when a restored/deep-linked thread
    // starts in the collapsed view.
    return [...firstSubagents.slice(0, AGENT_SWITCHER_VISIBLE_LIMIT - 1), currentSubagent];
  }, [currentThread.id, isExpanded, subagents]);
  const canToggleExpanded = subagents.length > AGENT_SWITCHER_VISIBLE_LIMIT;

  const anyRunning =
    root.status === 'running' || subagents.some(({ thread }) => thread.status === 'running');
  useRunTicker(anyRunning);

  if (subagents.length === 0) return null;

  const renderRow = (thread: Thread, isMain: boolean, depth: number) => {
    const lastRun = [...thread.messages].reverse().find((m) => m.kind === 'agent-run');
    const duration = lastRun
      ? formatRunDuration(lastRun.startedAt, lastRun.completedAt)
      : '';
    const tokens = lastRun?.stats?.totalTokens;
    const active = thread.id === currentThread.id;
    const name = isMain
      ? 'main'
      : thread.subagent?.kind ?? thread.inheritedSubagent?.kind ?? thread.modelId.split(':')[1] ?? 'agent';
    const detail = thread.title;
    return (
      <button
        key={thread.id}
        type="button"
        className={`agent-switcher-row${active ? ' active' : ''}${isMain ? ' main' : ''}`}
        style={depth > 1 ? { paddingLeft: 10 + depth * 14 } : undefined}
        onClick={() => onSelect(thread.id)}
        title={detail}
      >
        <span className={`agent-switcher-dot status-${thread.status}`} aria-hidden="true" />
        <span className="agent-switcher-name">{name}</span>
        {!isMain && <span className="agent-switcher-title">{detail}</span>}
        <span className="agent-switcher-meta">
          {duration}
          {typeof tokens === 'number' && tokens > 0 && (
            <> · ↓ {formatTokenCount(tokens)} tokens</>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="agent-switcher-wrap" ref={wrapRef}>
      <button
        type="button"
        className="agent-switcher-label"
        onClick={() => setSectionOpenState(!sectionOpen)}
        aria-expanded={sectionOpen}
        title={sectionOpen ? 'Collapse subagents' : 'Expand subagents'}
      >
        <ChevronDown
          size={12}
          className={sectionOpen ? 'open' : ''}
          aria-hidden="true"
        />
        Subagents
        {split && ` (${subagents.length})`}
      </button>
      {sectionOpen && (
        <div
          className={`agent-switcher${isExpanded ? ' expanded' : ''}`}
          style={split && overlayMaxHeight != null ? { maxHeight: overlayMaxHeight } : undefined}
        >
          {renderRow(root, true, 0)}
          {visibleSubagents.map(({ thread, depth }) => renderRow(thread, false, depth + 1))}
          {canToggleExpanded && (
            <button
              type="button"
              className="agent-switcher-toggle"
              onClick={() => setExpandedRootId(isExpanded ? null : root.id)}
              aria-expanded={isExpanded}
            >
              <ChevronRight size={12} className={isExpanded ? 'open' : ''} />
              {isExpanded
                ? 'Show less'
                : `Show ${subagents.length - visibleSubagents.length} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// Failure text that means the provider CLI is logged out rather than that the
// turn itself went wrong. Matched against the terminal error text (plus the
// tail of the streamed output, where stderr lands) so the transcript can offer
// an Authenticate button instead of a dead-end error. Patterns cover every
// provider's logged-out phrasing: claude ("Invalid API key · Please run
// /login", "OAuth session expired"), codex ("Not logged in. Run codex login",
// 401s), cursor-agent ("Not authenticated"), grok ("login required"), opencode.
export const PROVIDER_AUTH_ERROR_PATTERNS: RegExp[] = [
  /invalid api key/i,
  /run \/login/i,
  /failed to authenticate/i,
  /authentication (failed|error|required)/i,
  /not (logged in|authenticated|signed in)/i,
  /(login|log ?in|sign ?in) (is )?required/i,
  /(oauth|auth(entication)?) (session|token)[^\n]{0,60}(expired|invalid|revoked)/i,
  /token (has )?expired/i,
  /\bunauthenticated\b/i,
  /\b401\b[^\n]{0,40}unauthorized/i,
  /unauthorized[^\n]{0,40}\b401\b/i,
  /run\s+`?(codex|cursor-agent|grok|opencode|claude|kimi|muse)\s+(auth\s+)?login/i,
  /please (log ?in|sign ?in)/i,
];

export const isProviderAuthErrorText = (text: string | null | undefined): boolean =>
  Boolean(text) && PROVIDER_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text as string));

/** Inline "this CLI is logged out" prompt shown in place of a dead-end turn error. */
export const ProviderAuthPrompt: React.FC<{
  providerId: string;
  onAuthenticate: (providerId: string) => void;
  busy?: boolean;
}> = ({ providerId, onAuthenticate, busy }) => {
  const label =
    agentProviders.find((provider) => provider.id === providerId)?.label ?? providerId;
  return (
    <div className="agent-error agent-auth-error">
      <span>
        {label} is logged out. Authenticate, then send your message again.
      </span>
      <button
        type="button"
        className="provider-auth-button compact"
        onClick={() => onAuthenticate(providerId)}
        disabled={busy}
      >
        {busy ? 'Authenticating…' : 'Authenticate'}
      </button>
    </div>
  );
};

const workSinceIso = (messages: Message[], message: Message) => {
  const since = workStartedAt(messages, message);
  return Number.isFinite(since) ? new Date(since).toISOString() : undefined;
};

// "Working for 5s" while the run is live: its own ticking component, so the
// memoized message around it doesn't re-render every second.
const RunElapsed: React.FC<{ startedAt?: string; completedAt?: string; running: boolean }> = ({
  startedAt,
  completedAt,
  running,
}) => {
  useRunTicker(running);
  const duration = formatRunDuration(startedAt, completedAt);
  return <>{duration || '0s'}</>;
};

/**
 * One agent turn, as in T3 Code: no cards. A plain "Working for 5s" line
 * heads the live turn with its steps listed flat underneath; once it ends the
 * line reads "Worked for 8s ›" and the steps fold away behind it, leaving the
 * final answer. Stops, failures and background waits keep their status line.
 * The time counts from the user's message (`workSince`), so a turn the agent
 * was re-invoked for after a background wait includes the wait.
 */
const AgentRunMessage: React.FC<{
  message: Message;
  workSince?: string;
  runRunning?: boolean;
  btwExchanges: BtwExchange[];
  renderBtwAside?: (exchange: BtwExchange) => React.ReactNode;
  onAuthenticateProvider?: (providerId: string) => void;
  authenticatingProviderId?: string | null;
}> = ({ message, workSince, runRunning, btwExchanges, renderBtwAside, onAuthenticateProvider, authenticatingProviderId }) => {
  const isRunning = message.status === 'running';
  const startedAt = workSince ?? message.startedAt;
  const [stepsOpen, setStepsOpen] = useState(false);
  const hasContent = message.content.trim().length > 0;
  const activities = message.activities ?? [];
  const showStatusText = !!message.statusText && !isRunning && message.statusText !== 'Finished.';
  const segments = buildAgentRunSegments(message.content, activities, btwExchanges);
  // Folded: only what came after the last step (the answer). With no steps
  // there is nothing to fold.
  const lastStepIndex = segments.reduce((last, segment, index) => (segment.kind === 'activities' ? index : last), -1);
  const foldable = !isRunning && lastStepIndex >= 0;
  const folded = foldable && !stepsOpen;
  const visibleSegments = folded ? segments.slice(lastStepIndex + 1) : segments;
  const lastSegment = segments.at(-1);
  // Between steps (or before the first), say the agent is thinking.
  const thinking =
    isRunning &&
    (!lastSegment ||
      (lastSegment.kind === 'activities' &&
        !lastSegment.activities.some((activity) => activity.status === 'running' || activity.status === 'waiting')));

  return (
    <div className={`message agent agent-run ${message.status ?? ''}`}>
      {(isRunning || message.startedAt) && (
        <div className="agent-run-header">
          {foldable ? (
            <button
              type="button"
              className="agent-run-header-toggle"
              onClick={() => setStepsOpen((open) => !open)}
              aria-expanded={stepsOpen}
              title={stepsOpen ? 'Hide the steps' : 'Show the steps'}
            >
              Worked for <RunElapsed startedAt={startedAt} completedAt={message.completedAt} running={false} />
              <ChevronRight size={14} className={`agent-run-header-chevron${stepsOpen ? ' open' : ''}`} />
            </button>
          ) : (
            <span>
              {isRunning ? 'Working for ' : 'Worked for '}
              <RunElapsed startedAt={startedAt} completedAt={message.completedAt} running={isRunning} />
            </span>
          )}
        </div>
      )}
      {showStatusText && (
        <div className="agent-status-line">
          <span>{message.statusText}</span>
        </div>
      )}
      {visibleSegments.map((segment, index) =>
        segment.kind === 'activities' ? (
          <AgentActivityCard
            key={segment.activities[0].id}
            activities={segment.activities}
            runStatus={message.status}
            runRunning={runRunning}
            live={isRunning && index === visibleSegments.length - 1}
          />
        ) : segment.kind === 'btw' ? (
          <React.Fragment key={`btw-${segment.exchange.id}`}>{renderBtwAside?.(segment.exchange)}</React.Fragment>
        ) : segment.text.trim() ? (
          <StreamingMarkdownContent key={`text-${index}`} content={segment.text} />
        ) : null
      )}
      {thinking && (
        <div className="work-row thinking">
          <span className="work-row-line">
            <span className="work-row-icon">
              <Brain size={14} />
            </span>
            <span className="work-row-label live">Thinking</span>
          </span>
        </div>
      )}
      {message.error &&
        (message.authProviderId && onAuthenticateProvider ? (
          <ProviderAuthPrompt
            providerId={message.authProviderId}
            onAuthenticate={onAuthenticateProvider}
            busy={authenticatingProviderId === message.authProviderId}
          />
        ) : (
          <div className="agent-error">{message.error}</div>
        ))}
      {hasContent && !isRunning && <CopyMessageButton text={message.content} />}
    </div>
  );
};

export type ChatMessageProps = {
  message: Message;
  /** An agent run's work start (ISO): the user's message it answers, see workStartedAt. */
  workSince?: string;
  /** Whether work owned by this turn is still live, including background agents. */
  runRunning?: boolean;
  /** The thread's currently linked tasks, for live status on the message's task chips. */
  liveTasks?: LinkedBoardTask[];
  taskBusy?: boolean;
  onMarkTaskDone?: (taskId: string) => void;
  onUnlinkTask?: (taskId: string) => void;
  btwExchanges?: BtwExchange[];
  renderBtwAside?: (exchange: BtwExchange) => React.ReactNode;
  onAuthenticateProvider?: (providerId: string) => void;
  authenticatingProviderId?: string | null;
  onDiscardClaudeBackgroundTasks?: (messageId: string, runId: string) => void;
};

export const ChatMessage = React.memo(function ChatMessage({
  message,
  workSince,
  runRunning,
  liveTasks,
  taskBusy,
  onMarkTaskDone,
  onUnlinkTask,
  btwExchanges = [],
  renderBtwAside,
  onAuthenticateProvider,
  authenticatingProviderId,
  onDiscardClaudeBackgroundTasks,
}: ChatMessageProps) {
  const attachments = message.attachments ?? [];
  const messageTasks = message.linkedTasks ?? [];
  const isAgentRun = message.role === 'agent' && message.kind === 'agent-run';
  const backgroundIntervention = message.claudeBackgroundIntervention;

  if (message.kind === 'claude-background-intervention' && backgroundIntervention) {
    // Background shells the finished turn left running (dev servers, watchers),
    // as in T3 Code: one quiet line with a Stop action, gone once they end on
    // their own. Shells the agent waits on never get here: they keep the turn
    // Working (wait_for_background_tasks).
    const { status, tasks, error } = backgroundIntervention;
    if (status === 'settled') return null;
    const only = tasks.length === 1 ? tasks[0] : null;
    return (
      <div className="message system claude-background-shells" title={tasks.join('\n')}>
        <Terminal size={13} />
        <span className="claude-background-shells-label">
          {status === 'stopped' ? 'Stopped ' : 'Running '}
          {only ? <code>{only}</code> : `${tasks.length} background commands`}
        </span>
        {status === 'error' && error && <span className="claude-background-shells-error">{error}</span>}
        {status !== 'stopped' && onDiscardClaudeBackgroundTasks && (
          <button
            type="button"
            className="claude-background-shells-stop"
            disabled={status === 'stopping'}
            onClick={() => onDiscardClaudeBackgroundTasks(message.id, backgroundIntervention.runId)}
          >
            {status === 'stopping' ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
    );
  }

  if (isAgentRun) {
    return (
      <AgentRunMessage
        message={message}
        workSince={workSince}
        runRunning={runRunning}
        btwExchanges={btwExchanges}
        renderBtwAside={renderBtwAside}
        onAuthenticateProvider={onAuthenticateProvider}
        authenticatingProviderId={authenticatingProviderId}
      />
    );
  }

  return (
    <div className={`message ${message.role}`}>
      {message.role === 'agent' ? (
        <StreamingMarkdownContent content={message.content} />
      ) : (
        <>
          {messageTasks.map((messageTask) => {
            // Live status/actions only while the chip's task is still linked to
            // the thread; after an unlink it renders as a static snapshot.
            const liveMessageTask = liveTasks?.find((task) => task.id === messageTask.id);
            return (
              <div
                key={messageTask.id}
                className={`composer-task-chip message-task-chip status-${liveMessageTask?.lastStatus ?? 'linked'}`}
                title={messageTask.description || messageTask.title}
              >
                <SquareKanban size={13} />
                <span className="composer-task-title">{messageTask.title}</span>
                <span className="composer-task-status">
                  {liveMessageTask ? linkedTaskStatusLabel(liveMessageTask.lastStatus) : 'Linked'}
                </span>
                {liveMessageTask && liveMessageTask.lastStatus !== 'done' && !taskBusy && onMarkTaskDone && (
                  <button
                    type="button"
                    className="composer-task-action done"
                    onClick={() => onMarkTaskDone(messageTask.id)}
                    title="Mark the task as done on the board"
                  >
                    <CircleCheck size={13} />
                  </button>
                )}
                {liveMessageTask && onUnlinkTask && (
                  <button
                    type="button"
                    className="composer-task-action"
                    onClick={() => onUnlinkTask(messageTask.id)}
                    title="Unlink task"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
          {message.content && (
            <div className="whitespace-pre-wrap break-words">
              <ThreadReferenceText text={message.content} />
            </div>
          )}
          {attachments.length > 0 && (
            <div className="message-attachments">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="message-attachment" title={attachment.path}>
                  <AttachmentThumb attachment={attachment} />
                  <span>{attachment.name}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {(message.role === 'user' || message.role === 'agent') && message.content.trim() && (
        <CopyMessageButton text={message.content} />
      )}
    </div>
  );
});

export const AgentsWelcome: React.FC<{
  projectName?: string | null;
  selectedProjectId?: string | null;
  canChangeProject?: boolean;
  /** When provided (and changing is allowed), the project name opens the project picker. */
  onOpenProjectPicker?: () => void;
  /** Enables the Claude Code / Codex import card above the heading. */
  agentModels?: AgentModel[];
}> = ({ projectName, selectedProjectId, canChangeProject, onOpenProjectPicker, agentModels }) => {
  // Always interactive when changing is allowed: "No project" is an option
  // even before any project has been added.
  const interactive = !!canChangeProject && !!onOpenProjectPicker;
  const noProject = isNoProjectId(selectedProjectId);

  return (
    <div className="agents-welcome">
      {agentModels && <SessionImportCard agentModels={agentModels} />}
      <div className="agents-welcome-icon">
        <Sparkles size={26} />
      </div>
      <h2>
        {noProject ? 'What should we work on' : 'What should we build in'}{' '}
        {interactive ? (
          <span className="agents-welcome-project">
            <button
              type="button"
              className="agents-welcome-project-trigger"
              onClick={onOpenProjectPicker}
              aria-haspopup="dialog"
              title="Change project"
            >
              <strong>{noProject ? 'without a project' : (projectName ?? 'this project')}</strong>
              <ChevronDown size={18} className="agents-welcome-project-chevron" />
            </button>
          </span>
        ) : (
          <strong>{noProject ? 'without a project' : (projectName ?? 'this project')}</strong>
        )}
        ?
      </h2>
    </div>
  );
};

/** A thread's last transcript position: raw offset plus whether it sat at the end. */
export type ChatScrollPosition = { top: number; pinned: boolean };

/**
 * Scroll state for one transcript. The split view mounts a transcript per pane,
 * so each pane gets its own set instead of sharing one shell-wide group.
 */
export type PaneChatRefs = {
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  chatPinnedRef: React.MutableRefObject<boolean>;
  chatScrollTopRef: React.MutableRefObject<number>;
};

export type ChatTranscriptProps = {
  threadId: string;
  projectName?: string | null;
  /** Welcome-screen project picker (only used while the thread is empty). */
  canChangeProject?: boolean;
  onOpenProjectPicker?: () => void;
  /** Models available for imported Claude Code / Codex threads (welcome screen). */
  agentModels?: AgentModel[];
  mediaBaseDirs: string[];
  isSending: boolean;
  steerSupported: boolean;
  steerReady: boolean;
  authenticatingProviderId: string | null;
  /** Scroll bookkeeping for the pane this transcript is mounted in. */
  chatScrollRef: PaneChatRefs['chatScrollRef'];
  chatEndRef: PaneChatRefs['chatEndRef'];
  chatPinnedRef: PaneChatRefs['chatPinnedRef'];
  chatScrollTopRef: PaneChatRefs['chatScrollTopRef'];
  /** Where each thread was left, so switching agents comes back to that spot. */
  chatScrollPositionsRef: React.MutableRefObject<Map<string, ChatScrollPosition>>;
  tasksCardPosition: { x: number; y: number } | null;
  tasksCardCollapsed: boolean;
  tasksCardDismissedFor: string | null;
  onMoveTasksCard: (threadId: string, position: { x: number; y: number }) => void;
  onToggleTasksCard: (threadId: string) => void;
  onDismissTasksCard: (threadId: string, messageId: string) => void;
  onMarkTaskDone: (threadId: string, taskId: string) => void;
  onUnlinkTask: (threadId: string, taskId: string) => void;
  onDismissBtwExchange: (threadId: string, exchangeId: string) => void;
  onAuthenticateProvider: (providerId: string) => void;
  onDiscardClaudeBackgroundTasks: (threadId: string, messageId: string, runId: string) => void;
  onSteerQueuedMessage: (threadId: string, queuedId: string) => void;
};

/**
 * Owns the high-frequency selected-thread subscription. Streaming chunks now
 * re-render this boundary only; memoized historical messages retain their
 * object identity and are skipped by React.
 */
export const ChatTranscript = React.memo(function ChatTranscript({
  threadId,
  projectName,
  canChangeProject,
  onOpenProjectPicker,
  agentModels,
  mediaBaseDirs,
  isSending,
  steerSupported,
  steerReady,
  authenticatingProviderId,
  chatScrollRef,
  chatEndRef,
  chatPinnedRef,
  chatScrollTopRef,
  chatScrollPositionsRef,
  tasksCardPosition,
  tasksCardCollapsed,
  tasksCardDismissedFor,
  onMoveTasksCard,
  onToggleTasksCard,
  onDismissTasksCard,
  onMarkTaskDone,
  onUnlinkTask,
  onDismissBtwExchange,
  onAuthenticateProvider,
  onDiscardClaudeBackgroundTasks,
  onSteerQueuedMessage,
}: ChatTranscriptProps) {
  const { thread, removeQueuedThreadMessage } = useOrionStore(
    useShallow((state) => ({
      thread: state.threads.find((candidate) => candidate.id === threadId),
      removeQueuedThreadMessage: state.removeQueuedThreadMessage,
    }))
  );
  const latestAgentRun = useMemo(() => {
    const messages = thread?.messages;
    if (!messages) return null;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === 'agent' && message.kind === 'agent-run') return message;
    }
    return null;
  }, [thread?.messages]);
  const floatingPlan = useMemo(() => {
    if (!latestAgentRun) return null;
    const activity = latestAgentRun.activities?.find((entry) => entry.type === 'plan');
    if (!activity || (activity.plan?.length ?? 0) === 0) return null;
    return {
      messageId: latestAgentRun.id,
      activity,
      runStatus: latestAgentRun.status,
    };
  }, [latestAgentRun]);


  const { btwAsidesByAnchor, leadingBtwAsides, trailingBtwAsides } = useMemo(() => {
    const byAnchor = new Map<string, BtwExchange[]>();
    const leading: BtwExchange[] = [];
    const trailing: BtwExchange[] = [];
    if (!thread) {
      return {
        btwAsidesByAnchor: byAnchor,
        leadingBtwAsides: leading,
        trailingBtwAsides: trailing,
      };
    }

    const messageIds = new Set(thread.messages.map((message) => message.id));
    for (const exchange of thread.btwExchanges ?? []) {
      let anchorId =
        exchange.afterMessageId && messageIds.has(exchange.afterMessageId)
          ? exchange.afterMessageId
          : undefined;
      const exchangeTime = new Date(exchange.createdAt).getTime();
      if (!anchorId && Number.isFinite(exchangeTime)) {
        anchorId = [...thread.messages]
          .reverse()
          .find((message) => {
            const messageTime = new Date(message.ts).getTime();
            return Number.isFinite(messageTime) && messageTime <= exchangeTime;
          })?.id;
      }
      if (anchorId) {
        const anchored = byAnchor.get(anchorId);
        if (anchored) anchored.push(exchange);
        else byAnchor.set(anchorId, [exchange]);
      } else if (Number.isFinite(exchangeTime) && thread.messages.length > 0) {
        leading.push(exchange);
      } else {
        trailing.push(exchange);
      }
    }

    return {
      btwAsidesByAnchor: byAnchor,
      leadingBtwAsides: leading,
      trailingBtwAsides: trailing,
    };
  }, [thread]);

  const handleChatScroll = useCallback(() => {
    const element = chatScrollRef.current;
    if (!element) return;
    chatPinnedRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    chatScrollTopRef.current = element.scrollTop;
    chatScrollPositionsRef.current.set(threadId, {
      top: element.scrollTop,
      pinned: chatPinnedRef.current,
    });
  }, [chatPinnedRef, chatScrollPositionsRef, chatScrollRef, chatScrollTopRef, threadId]);

  // The subagent switcher swaps transcripts inside the *same* scroll container,
  // so the browser has nothing to restore: main came back pinned to whatever
  // offset the (much shorter) subagent transcript allowed, which reads as
  // "scrolled all the way back up". Each thread's last position is remembered on
  // scroll and re-applied here whenever the rendered thread changes — including
  // on remount, e.g. after a trip through the Code tab. Threads never visited
  // default to pinned, so a freshly opened thread still opens at the latest
  // message.
  useLayoutEffect(() => {
    const saved = chatScrollPositionsRef.current.get(threadId);
    chatPinnedRef.current = saved?.pinned ?? true;
    chatScrollTopRef.current = saved?.top ?? 0;

    const applyPosition = () => {
      const element = chatScrollRef.current;
      if (!element) return;
      element.scrollTo({
        top: chatPinnedRef.current ? element.scrollHeight : chatScrollTopRef.current,
        behavior: 'instant',
      });
    };

    applyPosition();
    // Markdown, code blocks and images can settle a frame late and shift the
    // transcript out from under the restored offset; re-apply once they have.
    const frame = requestAnimationFrame(applyPosition);
    return () => cancelAnimationFrame(frame);
  }, [chatPinnedRef, chatScrollPositionsRef, chatScrollRef, chatScrollTopRef, threadId]);

  useEffect(() => {
    if (!chatPinnedRef.current) return;
    chatEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [
    chatEndRef,
    chatPinnedRef,
    isSending,
    thread?.messages,
    thread?.queuedMessages,
    thread?.btwExchanges,
  ]);

  const handleMarkTaskDone = useCallback(
    (taskId: string) => onMarkTaskDone(threadId, taskId),
    [onMarkTaskDone, threadId]
  );
  const handleUnlinkTask = useCallback(
    (taskId: string) => onUnlinkTask(threadId, taskId),
    [onUnlinkTask, threadId]
  );
  const handleDiscardClaudeBackgroundTasks = useCallback(
    (messageId: string, runId: string) =>
      onDiscardClaudeBackgroundTasks(threadId, messageId, runId),
    [onDiscardClaudeBackgroundTasks, threadId]
  );
  const handleMoveTasksCard = useCallback(
    (position: { x: number; y: number }) => onMoveTasksCard(threadId, position),
    [onMoveTasksCard, threadId]
  );
  const handleToggleTasksCard = useCallback(
    () => onToggleTasksCard(threadId),
    [onToggleTasksCard, threadId]
  );
  const handleDismissTasksCard = useCallback(() => {
    if (floatingPlan) onDismissTasksCard(threadId, floatingPlan.messageId);
  }, [floatingPlan, onDismissTasksCard, threadId]);
  const renderBtwAside = useCallback(
    (exchange: BtwExchange) => (
      <div key={exchange.id} className={`btw-aside ${exchange.status}`}>
        <div className="btw-aside-bar">
          <span className="btw-aside-badge">
            <Sparkles size={11} />
            BTW
          </span>
          <span className="btw-aside-note">
            aside · answered from a fork · not part of the thread
          </span>
          <button
            type="button"
            className="btw-aside-dismiss"
            onClick={() => onDismissBtwExchange(threadId, exchange.id)}
            title={
              exchange.status === 'running'
                ? 'Cancel and dismiss this aside'
                : 'Dismiss this aside'
            }
          >
            <X size={12} />
          </button>
        </div>
        <div className="btw-aside-question">{exchange.question}</div>
        {exchange.status === 'running' && !exchange.answer && (
          <div className="agent-status-line running">
            <span className="working-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>Answering on the side…</span>
          </div>
        )}
        {exchange.answer && (
          <div className="btw-aside-answer">
            <StreamingMarkdownContent content={exchange.answer} />
          </div>
        )}
        {exchange.status === 'error' &&
          (exchange.authProviderId ? (
            <ProviderAuthPrompt
              providerId={exchange.authProviderId}
              onAuthenticate={onAuthenticateProvider}
              busy={authenticatingProviderId === exchange.authProviderId}
            />
          ) : (
            <div className="agent-error">{exchange.error ?? 'The aside failed.'}</div>
          ))}
      </div>
    ),
    [
      authenticatingProviderId,
      onAuthenticateProvider,
      onDismissBtwExchange,
      threadId,
    ]
  );

  if (!thread) return null;

  return (
    <div className="chat-scroll-wrap">
      <div
        className="chat-scroll"
        ref={chatScrollRef}
        onScroll={handleChatScroll}
        data-lightbox-scope=""
      >
        <MarkdownBaseDirContext.Provider value={mediaBaseDirs}>
          <div className="chat-container">
            {thread.messages.length === 0 && (
              <AgentsWelcome
                projectName={projectName}
                selectedProjectId={thread.projectId}
                canChangeProject={canChangeProject}
                onOpenProjectPicker={onOpenProjectPicker}
                agentModels={agentModels}
              />
            )}

            {leadingBtwAsides.map(renderBtwAside)}

            {thread.messages.map((message) => (
              <React.Fragment key={message.id}>
                <ChatMessage
                  message={message}
                  workSince={message.kind === 'agent-run' ? workSinceIso(thread.messages, message) : undefined}
                  runRunning={
                    message.status === 'running' ||
                    (message.id === latestAgentRun?.id && thread.status === 'running')
                  }
                  liveTasks={thread.linkedTasks}
                  taskBusy={isSending}
                  onMarkTaskDone={handleMarkTaskDone}
                  onUnlinkTask={handleUnlinkTask}
                  btwExchanges={
                    message.kind === 'agent-run'
                      ? btwAsidesByAnchor.get(message.id)
                      : undefined
                  }
                  renderBtwAside={renderBtwAside}
                  onAuthenticateProvider={onAuthenticateProvider}
                  authenticatingProviderId={authenticatingProviderId}
                  onDiscardClaudeBackgroundTasks={handleDiscardClaudeBackgroundTasks}
                />
                {message.kind !== 'agent-run' &&
                  btwAsidesByAnchor.get(message.id)?.map(renderBtwAside)}
              </React.Fragment>
            ))}

            {isSending &&
              thread.messages.at(-1)?.role !== 'agent' &&
              thread.messages.at(-1)?.kind !== 'claude-background-intervention' && (
              <div className="message agent opacity-70">Starting agent...</div>
            )}

            {(thread.queuedMessages ?? []).map((queued) => (
              <div key={queued.id} className="message user queued">
                {queued.text && (
                  <div className="whitespace-pre-wrap break-words">{queued.text}</div>
                )}
                {(queued.attachments?.length ?? 0) > 0 && (
                  <div className="message-attachments">
                    {queued.attachments!.map((attachment) => (
                      <div
                        key={attachment.id}
                        className="message-attachment"
                        title={attachment.path}
                      >
                        <AttachmentThumb attachment={attachment} />
                        <span>{attachment.name}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="queued-message-bar">
                  <span className="queued-message-badge">Queued</span>
                  {steerSupported && (
                    <button
                      type="button"
                      className="queued-message-action steer"
                      onClick={() => onSteerQueuedMessage(threadId, queued.id)}
                      disabled={!steerReady}
                      title={
                        steerReady
                          ? 'Send into the running turn now — the agent picks it up without losing its work'
                          : 'Steer is unavailable — sends when the current turn ends'
                      }
                    >
                      <Zap size={12} />
                      Steer now
                    </button>
                  )}
                  <button
                    type="button"
                    className="queued-message-action remove"
                    onClick={() => removeQueuedThreadMessage(threadId, queued.id)}
                    title="Remove queued message"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}

            {trailingBtwAsides.map(renderBtwAside)}
            <div ref={chatEndRef} />
          </div>
        </MarkdownBaseDirContext.Provider>
      </div>

      {floatingPlan && tasksCardDismissedFor !== floatingPlan.messageId && (
        <FloatingTasksCard
          activity={floatingPlan.activity}
          runStatus={floatingPlan.runStatus}
          runRunning={
            floatingPlan.runStatus === 'running' || thread.status === 'running'
          }
          position={tasksCardPosition}
          onMove={handleMoveTasksCard}
          collapsed={tasksCardCollapsed}
          onToggleCollapsed={handleToggleTasksCard}
          onDismiss={handleDismissTasksCard}
        />
      )}

    </div>
  );
});
