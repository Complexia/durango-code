import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bell, BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, FilePen, Globe, ListChecks, Search, Terminal, Wrench, X } from 'lucide-react';
import { type AgentActivity, type BtwExchange, type Message, type ThreadGoal, type TurnTokenStats } from '../store';

export const formatRunDuration = (startedAt?: string, completedAt?: string) => {
  if (!startedAt) return '';
  const started = new Date(startedAt).getTime();
  const ended = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return '';

  const seconds = Math.max(0, Math.round((ended - started) / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
};

export const AgentActivityIcon: React.FC<{ activity: AgentActivity }> = ({ activity }) => {
  if (activity.type === 'plan') return <ListChecks size={15} />;
  if (activity.kind === 'edit') return <FilePen size={15} />;
  if (activity.kind === 'read') return <BookOpen size={15} />;
  if (activity.kind === 'search') return <Search size={15} />;
  if (activity.kind === 'fetch') return <Globe size={15} />;
  if (activity.kind === 'task') return <Bot size={15} />;
  if (activity.type === 'thought') return <Brain size={15} />;
  if (activity.type === 'command' || activity.kind === 'execute') return <Terminal size={15} />;
  if (activity.type === 'error') return <X size={15} />;
  if (activity.type === 'result') return <Check size={15} />;
  return <Wrench size={15} />;
};

// A detail long enough that the one-line preview loses information — these
// rows expand on click to show the full text.
export const isExpandableDetail = (detail?: string) =>
  !!detail && (detail.length > 160 || detail.includes('\n'));

export const hostnameForUrl = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export const formatTokenCount = (value?: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
};

// Compact per-turn usage: "31.4k tokens · 82% cached · 1.2k reasoning".
export const formatTurnStats = (stats: TurnTokenStats) => {
  const parts: string[] = [];
  const total = formatTokenCount(stats.totalTokens ?? stats.inputTokens);
  if (total) parts.push(`${total} tokens`);
  if (
    typeof stats.cachedReadTokens === 'number' &&
    typeof stats.inputTokens === 'number' &&
    stats.inputTokens > 0
  ) {
    parts.push(`${Math.round((stats.cachedReadTokens / stats.inputTokens) * 100)}% cached`);
  }
  const reasoning = formatTokenCount(stats.reasoningTokens);
  if (reasoning && stats.reasoningTokens! > 0) parts.push(`${reasoning} reasoning`);
  if (
    typeof stats.contextTokens === 'number' &&
    typeof stats.contextWindow === 'number' &&
    stats.contextWindow > 0
  ) {
    parts.push(`${Math.round((stats.contextTokens / stats.contextWindow) * 100)}% context`);
  }
  return parts.join(' · ');
};

// Codex goal (/goal) presentation helpers.
export const goalStatusLabels: Record<ThreadGoal['status'], string> = {
  active: 'Pursuing',
  paused: 'Paused',
  blocked: 'Blocked',
  usageLimited: 'Usage-limited',
  budgetLimited: 'Budget hit',
  complete: 'Achieved',
};

export const goalUsageSummary = (goal: ThreadGoal) => {
  const used = formatTokenCount(goal.tokensUsed ?? 0) ?? '0';
  const budget =
    typeof goal.tokenBudget === 'number' ? formatTokenCount(goal.tokenBudget) : null;
  if (budget) return `${used}/${budget} tokens`;
  if ((goal.tokensUsed ?? 0) > 0) return `${used} tokens`;
  return '';
};

export const goalSummaryLine = (goal: ThreadGoal) => {
  const usage = goalUsageSummary(goal);
  return `${goalStatusLabels[goal.status] ?? goal.status}: ${goal.objective}${usage ? ` · ${usage}` : ''}`;
};

// Live task checklist streamed by the agent (grok ACP plan updates). Once the
// run ends the in-progress task keeps its place in the list but stops
// spinning — it marks where the agent got to, not work still happening.
export const AgentPlanChecklist: React.FC<{ activity: AgentActivity; running: boolean }> = ({
  activity,
  running,
}) => (
  <div className="agent-plan-list">
    {(activity.plan ?? []).map((entry, index) => {
      const halted = entry.status === 'in_progress' && !running;
      return (
        <div key={index} className={`agent-plan-entry ${entry.status}${halted ? ' halted' : ''}`}>
          <span className="agent-plan-marker">
            {entry.status === 'completed' ? (
              <Check size={12} />
            ) : halted ? (
              <span className="agent-plan-halted" aria-hidden="true" />
            ) : entry.status === 'in_progress' ? (
              <span className="agent-plan-spinner" aria-hidden="true" />
            ) : (
              <span className="agent-plan-dot" aria-hidden="true" />
            )}
          </span>
          <span className="agent-plan-content">{entry.content}</span>
          {halted && <span className="agent-plan-halted-tag">stopped here</span>}
        </div>
      );
    })}
  </div>
);

// How the Tasks card describes a plan whose run is no longer live.
const endedRunLabel = (status?: Message['status']) => {
  if (status === 'error') return 'Failed';
  if (status === 'stopped') return 'Stopped';
  return 'Ended';
};

// Drag + clamp behavior for the floating Tasks card pinned over the chat
// area. Keeps the card inside its positioned host while it is dragged and
// when the host resizes.
export const useFloatingCardDrag = (
  position: { x: number; y: number } | null,
  onMove: (position: { x: number; y: number }) => void
) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hostMaxHeight, setHostMaxHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const host = card?.offsetParent as HTMLElement | null;
    if (!card || !host) return undefined;

    const clampToHost = () => {
      const margin = 8;
      const nextMaxHeight = Math.max(host.clientHeight - margin * 2, 0);
      setHostMaxHeight((current) => (current === nextMaxHeight ? current : nextMaxHeight));
      if (!position) return;
      const maxX = Math.max(host.clientWidth - card.offsetWidth - margin, margin);
      const maxY = Math.max(host.clientHeight - card.offsetHeight - margin, margin);
      const next = {
        x: Math.min(Math.max(position.x, margin), maxX),
        y: Math.min(Math.max(position.y, margin), maxY),
      };
      if (next.x !== position.x || next.y !== position.y) onMove(next);
    };

    clampToHost();
    const observer = new ResizeObserver(clampToHost);
    observer.observe(host);
    observer.observe(card);
    return () => observer.disconnect();
  }, [onMove, position]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Header buttons (collapse/close) should click, not start a drag.
    if ((event.target as HTMLElement).closest('button')) return;
    const card = cardRef.current;
    const host = card?.offsetParent as HTMLElement | null;
    if (!card || !host) return;
    event.preventDefault();
    const cardRect = card.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const grabX = event.clientX - cardRect.left;
    const grabY = event.clientY - cardRect.top;
    const margin = 8;
    setDragging(true);
    const handleMove = (move: PointerEvent) => {
      const maxX = hostRect.width - cardRect.width - margin;
      const maxY = hostRect.height - cardRect.height - margin;
      onMove({
        x: Math.min(Math.max(move.clientX - hostRect.left - grabX, margin), Math.max(maxX, margin)),
        y: Math.min(Math.max(move.clientY - hostRect.top - grabY, margin), Math.max(maxY, margin)),
      });
    };
    const handleUp = () => {
      setDragging(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  return { cardRef, dragging, hostMaxHeight, handlePointerDown };
};

// Floating, movable "Tasks" card pinned over the chat area. Only rendered
// when the current agent turn streamed a plan (grok ACP task list) — simple
// turns that never emit tasks never show it. Mirrors the same plan activity
// that lives inside the run's step list, so it needs no extra plumbing.
export const FloatingTasksCard: React.FC<{
  activity: AgentActivity;
  runStatus?: Message['status'];
  runRunning: boolean;
  position: { x: number; y: number } | null;
  onMove: (position: { x: number; y: number }) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onDismiss: () => void;
}> = ({
  activity,
  runStatus,
  runRunning,
  position,
  onMove,
  collapsed,
  onToggleCollapsed,
  onDismiss,
}) => {
  const { cardRef, dragging, hostMaxHeight, handlePointerDown } = useFloatingCardDrag(
    position,
    onMove
  );

  const entries = activity.plan ?? [];
  const completed = entries.filter((entry) => entry.status === 'completed').length;
  const allDone = entries.length > 0 && completed === entries.length;
  const activeEntry = entries.find((entry) => entry.status === 'in_progress');
  // A finished-but-incomplete plan is the interesting case: say the run ended
  // and keep pointing at the task it never got past.
  const endedLabel = !runRunning && !allDone ? endedRunLabel(runStatus) : null;

  return (
    <div
      ref={cardRef}
      className={`tasks-float-card${collapsed ? ' collapsed' : ''}${dragging ? ' dragging' : ''}${
        endedLabel ? ' ended' : ''
      }${runStatus === 'error' ? ' failed' : ''}`}
      style={{
        ...(position ? { left: position.x, top: position.y, right: 'auto' } : {}),
        ...(hostMaxHeight !== null ? { maxHeight: hostMaxHeight } : {}),
      }}
    >
      <div
        className="tasks-float-header"
        onPointerDown={handlePointerDown}
        onDoubleClick={onToggleCollapsed}
        title="Drag to move · double-click to collapse"
      >
        <span className="tasks-float-title">
          <ListChecks size={13} />
          <span>Tasks</span>
          <span className="tasks-float-progress">
            {completed}/{entries.length}
          </span>
          {allDone ? (
            <span className="tasks-float-state done">
              <Check size={12} />
            </span>
          ) : runRunning ? (
            <span className="agent-plan-spinner" aria-hidden="true" />
          ) : (
            <span className="tasks-float-state ended">{endedLabel}</span>
          )}
        </span>
        <span className="tasks-float-actions">
          <button
            type="button"
            onClick={onToggleCollapsed}
            title={collapsed ? 'Expand tasks' : 'Collapse tasks'}
          >
            <ChevronDown size={13} />
          </button>
          <button type="button" onClick={onDismiss} title="Hide tasks card">
            <X size={13} />
          </button>
        </span>
      </div>
      <div className="tasks-float-meter" aria-hidden="true">
        <span
          className="tasks-float-meter-fill"
          style={{ width: `${entries.length > 0 ? (completed / entries.length) * 100 : 0}%` }}
        />
      </div>
      {collapsed ? (
        activeEntry && (
          <div className={`tasks-float-current${endedLabel ? ' ended' : ''}`}>
            {endedLabel && <span className="tasks-float-current-label">{endedLabel} at</span>}
            <span className="tasks-float-current-text">{activeEntry.content}</span>
          </div>
        )
      ) : (
        <div className="tasks-float-body">
          <AgentPlanChecklist activity={activity} running={runRunning} />
        </div>
      )}
    </div>
  );
};

export const collapsedDetailPreview = (activity: AgentActivity) => {
  const detail = activity.detail ?? '';
  // The preview shows at most a few hundred characters, but reasoning details
  // grow to hundreds of KB over a long turn and this runs on every streamed
  // update — flatten only the slice that can actually be shown.
  const truncated = detail.length > 1200;
  const window = activity.type === 'thought' ? detail.slice(-1200) : detail.slice(0, 1200);
  const flattened = window.replace(/\s+/g, ' ').trim();
  // Thought streams show the tail so the row tracks what the agent is
  // thinking now, not the opening words. The row is a one-line ellipsized
  // span, so the leading cap is invisible for other types.
  if (activity.type === 'thought' && (flattened.length > 300 || truncated)) {
    return `…${flattened.slice(-300)}`;
  }
  return flattened;
};

// What a step did, for its icon and the group summary ("Ran 3 commands and
// read 2 files"), as in T3 Code's work log.
export type ActivityAction = 'command' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'thought' | 'update' | 'other';

const toolNameOf = (activity: AgentActivity) =>
  activity.title.startsWith('Tool - ') ? activity.title.slice('Tool - '.length).trim() : '';

const isCommandActivity = (activity: AgentActivity) =>
  activity.type === 'command' || activity.kind === 'execute' || activity.title.startsWith('Command - ');

export const activityAction = (activity: AgentActivity): ActivityAction => {
  if (activity.type === 'thought') return 'thought';
  if (isCommandActivity(activity)) return 'command';
  if (activity.title.startsWith('Background task')) return 'update';
  const name = toolNameOf(activity);
  if (activity.kind === 'edit' || /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/.test(name) || activity.title.startsWith('File changes')) {
    return 'edit';
  }
  if (activity.kind === 'read' || /^(Read|LS)$/.test(name)) return 'read';
  if (activity.kind === 'search' || /^(Grep|Glob)$/.test(name)) return 'search';
  if (activity.kind === 'fetch' || /^(WebFetch|WebSearch)$/.test(name) || activity.title === 'Web search') return 'web';
  if (activity.kind === 'task' || /^(Task|Agent)$/.test(name) || activity.title.startsWith('Subagents')) return 'agent';
  return 'other';
};

const firstLine = (text: string) => text.trim().split('\n', 1)[0] ?? '';

// Long absolute paths keep their tail: the file name is what identifies them.
const shortPath = (path: string) => {
  const parts = path.split('/').filter(Boolean);
  return path.length > 48 && parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path;
};

const humanToolName = (name: string) => {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp) return name;
  const tool = mcp[2].replace(/_/g, ' ');
  return `${tool.charAt(0).toUpperCase()}${tool.slice(1)} · ${mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')}`;
};

/** One line saying what a step did. `code` marks a shell command, set in mono. */
export const activityLabel = (activity: AgentActivity): { text: string; code?: boolean } => {
  const detail = firstLine(activity.detail ?? '');
  if (activity.type === 'thought') return { text: collapsedDetailPreview(activity) || 'Thought' };
  if (isCommandActivity(activity)) {
    return { text: detail || firstLine(activity.input ?? '') || activity.title.replace(/^Command - /, ''), code: true };
  }
  const name = toolNameOf(activity);
  if (!name) return { text: detail && detail !== activity.title ? `${activity.title} · ${detail}` : activity.title };
  switch (name) {
    case 'Read':
      return { text: detail ? `Read ${shortPath(detail)}` : 'Read a file' };
    case 'Write':
      return { text: detail ? `Wrote ${shortPath(detail)}` : 'Wrote a file' };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { text: detail ? `Edited ${shortPath(detail)}` : 'Edited a file' };
    case 'LS':
      return { text: detail ? `Listed ${shortPath(detail)}` : 'Listed files' };
    case 'Grep':
      return { text: detail ? `Searched for ${detail}` : 'Searched code' };
    case 'Glob':
      return { text: detail ? `Found files matching ${detail}` : 'Found files' };
    case 'WebFetch':
      return { text: detail ? `Fetched ${hostnameForUrl(detail)}` : 'Fetched a page' };
    case 'WebSearch':
      return { text: detail ? `Searched the web for ${detail}` : 'Searched the web' };
    case 'Task':
    case 'Agent':
      return { text: detail ? `Agent: ${detail}` : 'Ran an agent' };
    case 'ToolSearch':
      return { text: 'Loaded tools' };
    case 'Skill':
      return { text: detail ? `Used the ${detail} skill` : 'Used a skill' };
    default: {
      const label = humanToolName(name);
      // An MCP call's summarized input is usually a JSON blob: noise on one line.
      return { text: detail && !detail.startsWith('{') ? `${label} · ${detail}` : label };
    }
  }
};

export const ActivityActionIcon: React.FC<{ action: ActivityAction | 'mixed' }> = ({ action }) => {
  switch (action) {
    case 'command':
      return <Terminal size={14} />;
    case 'edit':
      return <FilePen size={14} />;
    case 'read':
      return <BookOpen size={14} />;
    case 'search':
      return <Search size={14} />;
    case 'web':
      return <Globe size={14} />;
    case 'agent':
      return <Bot size={14} />;
    case 'thought':
      return <Brain size={14} />;
    case 'update':
      return <Bell size={14} />;
    default:
      return <Wrench size={14} />;
  }
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const summaryPhrase = (action: ActivityAction, activities: AgentActivity[]) => {
  const count = activities.length;
  switch (action) {
    case 'command':
      return `Ran ${plural(count, 'command', 'commands')}`;
    case 'edit': {
      const files = new Set(activities.map((activity) => activity.diff?.path ?? activity.detail ?? activity.id));
      return `Changed ${plural(files.size, 'file', 'files')}`;
    }
    case 'read':
      return `Read ${plural(count, 'file', 'files')}`;
    case 'search':
      return `Searched code ${count === 1 ? 'once' : `${count} times`}`;
    case 'web':
      return `Used the web ${count === 1 ? 'once' : `${count} times`}`;
    case 'agent':
      return `Ran ${plural(count, 'agent', 'agents')}`;
    case 'update':
      return `Received ${plural(count, 'update', 'updates')}`;
    default:
      return `Used ${plural(count, 'tool', 'tools')}`;
  }
};

const summaryPriority = (action: ActivityAction) =>
  action === 'command' || action === 'edit' || action === 'agent' ? 0 : action === 'other' || action === 'update' ? 2 : 1;

/** "Ran 3 commands and read 2 files": the two weightiest kinds of step, in order. */
export const summarizeActivities = (activities: AgentActivity[]) => {
  const steps = activities.filter((activity) => activity.type !== 'thought');
  if (steps.length === 0) {
    return activities.length === 1 ? 'Thought' : `Thought (×${activities.length})`;
  }
  const groups = new Map<ActivityAction, AgentActivity[]>();
  for (const activity of steps) {
    const action = activityAction(activity);
    groups.set(action, [...(groups.get(action) ?? []), activity]);
  }
  const ranked = [...groups].map(([action, members], index) => ({ action, members, index }));
  const selected = [...ranked]
    .sort((a, b) => summaryPriority(a.action) - summaryPriority(b.action) || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = selected.map(({ action, members }) => summaryPhrase(action, members));
  const rest = steps.length - selected.reduce((count, group) => count + group.members.length, 0);
  if (rest > 0) labels.push(`performed ${plural(rest, 'other action', 'other actions')}`);
  const sentence = labels.map((label, index) => (index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)));
  return sentence.length < 3 ? sentence.join(' and ') : `${sentence.slice(0, -1).join(', ')}, and ${sentence.at(-1)}`;
};

const groupAction = (activities: AgentActivity[]): ActivityAction | 'mixed' => {
  const actions = new Set(activities.map(activityAction));
  return actions.size === 1 ? [...actions][0] : 'mixed';
};

const effectiveStatus = (activity: AgentActivity, runRunning: boolean) =>
  !runRunning && (activity.status === 'running' || activity.status === 'waiting') ? 'done' : activity.status ?? 'done';

const activityFailed = (activity: AgentActivity) =>
  activity.status === 'error' || activity.type === 'error' || (typeof activity.exitCode === 'number' && activity.exitCode !== 0);

// What an opened step shows: the full call and what it returned.
const ActivityDetails: React.FC<{ activity: AgentActivity; label: string }> = ({ activity, label }) => {
  const detail = activity.detail?.trim();
  const showDetail = !!detail && detail !== label && activity.type !== 'command' && detail !== activity.input?.trim();
  return (
    <div className="work-row-details" onClick={(event) => event.stopPropagation()}>
      {activity.type === 'thought' ? (
        <div className="work-row-thought">{activity.detail}</div>
      ) : (
        <>
          {showDetail && <pre className="agent-tool-output input">{activity.detail}</pre>}
          {activity.input && (
            <div className="agent-tool-io">
              <span className="agent-tool-io-label">Called with</span>
              <pre className="agent-tool-output input">{activity.input}</pre>
            </div>
          )}
          {activity.output && (
            <div className="agent-tool-io">
              <span className="agent-tool-io-label">Output</span>
              <pre className="agent-tool-output">{activity.output}</pre>
            </div>
          )}
        </>
      )}
      {!!activity.sources?.length && (
        <span className="agent-tool-sources">
          {activity.sources.slice(0, 4).map((source) => (
            <a
              key={source.url}
              href={source.url}
              title={source.url}
              onClick={(event) => {
                event.preventDefault();
                void window.orion?.openExternalUrl?.(source.url);
              }}
            >
              {hostnameForUrl(source.url)}
            </a>
          ))}
        </span>
      )}
    </div>
  );
};

const hasActivityDetails = (activity: AgentActivity) =>
  activity.type === 'thought'
    ? !!activity.detail?.trim()
    : !!(activity.output || activity.input || activity.sources?.length || isExpandableDetail(activity.detail));

// One step as a single muted line (T3 Code's work log row): icon, what it did,
// a +N −N or exit chip. Clicking a step with a call or output opens it in place.
const AgentActivityRow: React.FC<{
  activity: AgentActivity;
  runRunning: boolean;
  live?: boolean;
  open: boolean;
  onToggle: (id: string) => void;
  /** Clickable even without details of its own (the live row opens its group). */
  expandable?: boolean;
}> = React.memo(({ activity, runRunning, live = false, open, onToggle, expandable: forceExpandable }) => {
  const status = effectiveStatus(activity, runRunning);
  const failed = activityFailed(activity);
  const label = activityLabel(activity);
  const expandable = forceExpandable ?? hasActivityDetails(activity);

  if (activity.type === 'plan') {
    return (
      <div className={`agent-tool-row plan ${status}`}>
        <span className="agent-tool-icon">
          <AgentActivityIcon activity={activity} />
        </span>
        <span className="agent-tool-text">
          <span className="agent-tool-title">{activity.title}</span>
          <AgentPlanChecklist activity={activity} running={runRunning} />
        </span>
      </div>
    );
  }

  return (
    <div className={`work-row ${status}${failed ? ' failed' : ''}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="work-row-line"
        onClick={expandable ? () => onToggle(activity.id) : undefined}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        title={label.text}
      >
        <span className="work-row-icon">
          <ActivityActionIcon action={activityAction(activity)} />
        </span>
        <span className={`work-row-label${label.code ? ' code' : ''}${live && status === 'running' ? ' live' : ''}`}>
          {label.text}
        </span>
        {activity.diff && (
          <span className="work-row-diff" title={activity.diff.path}>
            <span className="diff-add">+{activity.diff.additions}</span>
            <span className="diff-delete">−{activity.diff.deletions}</span>
          </span>
        )}
        {typeof activity.exitCode === 'number' && activity.exitCode !== 0 && (
          <span className="agent-tool-chip exit">exit {activity.exitCode}</span>
        )}
        {status === 'waiting' && <span className="agent-tool-chip waiting">needs approval</span>}
        {failed && typeof activity.exitCode !== 'number' && <X size={12} className="work-row-failed" />}
      </button>
      {open && hasActivityDetails(activity) && <ActivityDetails activity={activity} label={label.text} />}
    </div>
  );
});

type ActivityChunk = { kind: 'steps'; activities: AgentActivity[] } | { kind: 'standalone'; activity: AgentActivity };

// Checklists and errors stand on their own; everything else between two
// stretches of text folds into one group.
const chunkActivities = (activities: AgentActivity[]): ActivityChunk[] => {
  const chunks: ActivityChunk[] = [];
  for (const activity of activities) {
    if (activity.type === 'plan' || activity.type === 'error') {
      chunks.push({ kind: 'standalone', activity });
      continue;
    }
    const last = chunks.at(-1);
    if (last?.kind === 'steps') last.activities.push(activity);
    else chunks.push({ kind: 'steps', activities: [activity] });
  }
  return chunks;
};

const useToggleSet = () => {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = useCallback(
    (id: string) =>
      setOpen((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    []
  );
  return [open, toggle] as const;
};

const ActivityGroup: React.FC<{
  activities: AgentActivity[];
  runRunning: boolean;
  live: boolean;
}> = ({ activities, runRunning, live }) => {
  const [openRows, toggleRow] = useToggleSet();
  const [expanded, setExpanded] = useState(false);
  const rows = (
    <div className="work-group-rows">
      {activities.map((activity) => (
        <AgentActivityRow
          key={activity.id}
          activity={activity}
          runRunning={runRunning}
          open={openRows.has(activity.id)}
          onToggle={toggleRow}
        />
      ))}
    </div>
  );

  // Live: the steps before it stay as they were (their summary line, or the
  // one step), and the step happening now (one awaiting approval first) takes
  // the Thinking line's place beneath them, so nothing above it jumps when a
  // step starts or ends.
  if (live) {
    const current =
      activities.findLast((activity) => activity.status === 'waiting') ??
      activities.findLast((activity) => activity.status === 'running') ??
      activities[activities.length - 1];
    if (expanded) {
      return (
        <div className="work-group">
          <WorkGroupSummary label={summarizeActivities(activities)} action={groupAction(activities)} expanded onToggle={() => setExpanded(false)} />
          {rows}
        </div>
      );
    }
    const earlier = activities.filter((activity) => activity !== current);
    return (
      <>
        {earlier.length === 1 && (
          <div className="work-group">
            <AgentActivityRow
              activity={earlier[0]}
              runRunning={runRunning}
              open={openRows.has(earlier[0].id)}
              onToggle={toggleRow}
            />
          </div>
        )}
        {earlier.length > 1 && (
          <div className="work-group">
            <WorkGroupSummary
              label={summarizeActivities(earlier)}
              action={groupAction(earlier)}
              failed={earlier.some(activityFailed)}
              expanded={false}
              onToggle={() => setExpanded(true)}
            />
          </div>
        )}
        <div className="work-group live">
          <AgentActivityRow
            activity={current}
            runRunning={runRunning}
            live
            open={openRows.has(current.id)}
            onToggle={toggleRow}
          />
        </div>
      </>
    );
  }

  if (activities.length === 1) {
    return (
      <div className="work-group">
        <AgentActivityRow
          activity={activities[0]}
          runRunning={runRunning}
          open={openRows.has(activities[0].id)}
          onToggle={toggleRow}
        />
      </div>
    );
  }

  return (
    <div className="work-group">
      <WorkGroupSummary
        label={summarizeActivities(activities)}
        action={groupAction(activities)}
        failed={activities.some(activityFailed)}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && rows}
    </div>
  );
};

const WorkGroupSummary: React.FC<{
  label: string;
  action: ActivityAction | 'mixed';
  failed?: boolean;
  expanded: boolean;
  onToggle: () => void;
}> = ({ label, action, failed = false, expanded, onToggle }) => (
  <button type="button" className={`work-group-summary${expanded ? ' open' : ''}`} onClick={onToggle} aria-expanded={expanded}>
    <span className="work-row-icon">
      <ActivityActionIcon action={action} />
    </span>
    <span className="work-row-label">{label}</span>
    {failed && <X size={12} className="work-row-failed" />}
    <ChevronRight size={13} className="work-group-chevron" />
  </button>
);

// A stretch of steps between two pieces of text, in T3 Code's work-log form:
// one summary line ("Ran 3 commands and read 2 files ›") once it is done, the
// current step alone while it runs. Plans and errors stay visible on their own.
export const AgentActivityCard: React.FC<{
  activities: AgentActivity[];
  runStatus?: Message['status'];
  runRunning?: boolean;
  /** This stretch is where the run is working right now. */
  live?: boolean;
  /** The agent is between steps: end the stretch with the Thinking line. */
  thinking?: boolean;
}> = ({ activities, runStatus, runRunning = runStatus === 'running', live = false, thinking = false }) => {
  const [openRows, toggleRow] = useToggleSet();
  if (activities.length === 0) return null;
  const chunks = chunkActivities(activities);
  return (
    <div className="agent-steps">
      {chunks.map((chunk, index) =>
        chunk.kind === 'standalone' ? (
          <AgentActivityRow
            key={chunk.activity.id}
            activity={chunk.activity}
            runRunning={runRunning}
            open={openRows.has(chunk.activity.id)}
            onToggle={toggleRow}
          />
        ) : (
          <ActivityGroup
            key={chunk.activities[0].id}
            activities={chunk.activities}
            runRunning={runRunning}
            live={
              live &&
              index === chunks.length - 1 &&
              chunk.activities.some((activity) => activity.status === 'running' || activity.status === 'waiting')
            }
          />
        )
      )}
      {thinking && <ThinkingRow />}
    </div>
  );
};

/** "Thinking" in the live step's place, so a starting step replaces it in place. */
export const ThinkingRow: React.FC = () => (
  <div className="work-row thinking">
    <span className="work-row-line">
      <span className="work-row-icon">
        <Brain size={14} />
      </span>
      <span className="work-row-label live">Thinking</span>
    </span>
  </div>
);

// Split an agent run into chronological segments: text that streamed before
// an activity renders before it, text after it renders after. Activities
// recorded before contentOffset existed (older messages) anchor at 0, which
// reproduces the previous steps-then-text layout.
export type AgentRunSegment =
  | { kind: 'text'; text: string }
  | { kind: 'activities'; activities: AgentActivity[] }
  | { kind: 'btw'; exchange: BtwExchange };

export const buildAgentRunSegments = (
  content: string,
  activities: AgentActivity[],
  btwExchanges: BtwExchange[] = []
): AgentRunSegment[] => {
  const segments: AgentRunSegment[] = [];
  let cursor = 0;

  const markers = [
    ...activities.map((activity, index) => ({
      kind: 'activity' as const,
      value: activity,
      offset: activity.contentOffset ?? 0,
      ts: activity.ts,
      index,
    })),
    ...btwExchanges.map((exchange, index) => ({
      kind: 'btw' as const,
      value: exchange,
      offset: exchange.contentOffset ?? content.length,
      ts: exchange.createdAt,
      index: activities.length + index,
    })),
  ].sort((a, b) => a.offset - b.offset || a.ts.localeCompare(b.ts) || a.index - b.index);

  for (const marker of markers) {
    const offset = Math.max(cursor, Math.min(marker.offset, content.length));
    if (offset > cursor) {
      segments.push({ kind: 'text', text: content.slice(cursor, offset) });
      cursor = offset;
    }
    if (marker.kind === 'btw') {
      segments.push({ kind: 'btw', exchange: marker.value });
      continue;
    }
    const last = segments[segments.length - 1];
    if (last?.kind === 'activities') {
      last.activities.push(marker.value);
    } else {
      segments.push({ kind: 'activities', activities: [marker.value] });
    }
  }

  if (cursor < content.length) {
    segments.push({ kind: 'text', text: content.slice(cursor) });
  }

  return segments;
};

// Re-render once a second while a run is active so the elapsed time ticks.
export const useRunTicker = (enabled: boolean) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const id = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
};
