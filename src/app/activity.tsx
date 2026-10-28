import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, FilePen, Globe, ListChecks, Search, Terminal, Wrench, X } from 'lucide-react';
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

// Tool input only adds expandable content when it is not already the visible
// detail line. Output and truncated/multiline details remain expandable.
export const isExpandableActivity = (activity: AgentActivity) =>
  activity.type !== 'plan' &&
  (!!activity.output ||
    isExpandableDetail(activity.detail) ||
    (!!activity.input && activity.input !== activity.detail));

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
  // Thought streams show the tail so the card tracks what the agent is
  // thinking now, not the opening words. The collapsed row is a one-line
  // ellipsized span, so the leading cap is invisible for other types.
  if (activity.type === 'thought' && (flattened.length > 300 || truncated)) {
    return `…${flattened.slice(-300)}`;
  }
  return flattened;
};

// One step row, memoized so a live card only re-renders the row whose
// activity object actually changed. During reasoning the tracker upserts one
// activity several times a second, and before this split every row in an
// expanded card re-rendered (and re-flattened its detail preview) on each
// upsert — per-update work proportional to the whole step history.
const AgentActivityRow: React.FC<{
  activity: AgentActivity;
  runRunning: boolean;
  rowExpanded: boolean;
  onToggle: (id: string) => void;
}> = React.memo(({ activity, runRunning, rowExpanded, onToggle }) => {
  const rowRunning = runRunning && activity.status === 'running';
  const status =
    !runRunning && (activity.status === 'running' || activity.status === 'waiting')
      ? 'done'
      : activity.status ?? 'done';
  const expandable = isExpandableActivity(activity);
  // Live terminal output shows a short tail while the tool runs so the user
  // watches the command work; the full text sits behind the row's expand
  // toggle.
  const showOutput = !!activity.output && (rowExpanded || rowRunning);
  const outputText =
    rowExpanded || !activity.output
      ? activity.output
      : activity.output.slice(-400).replace(/^[^\n]*\n/, '');
  // The detail line already previews a single-argument call (a path, a
  // command); repeating it verbatim as the input block is noise.
  const showInput = rowExpanded && !!activity.input && activity.input !== activity.detail;
  // "Command - git log" over a detail line that says "git log" again reads as
  // one step: show the command once.
  const title = activity.title.replace(/^Command - /, '');
  const detailRepeatsTitle = !rowExpanded && !!activity.detail && activity.detail.trim() === title.trim();

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
    <div
      className={`agent-tool-row ${status}${expandable ? ' expandable' : ''}${rowExpanded ? ' open' : ''}`}
      onClick={expandable ? () => onToggle(activity.id) : undefined}
      onKeyDown={
        expandable
          ? (event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onToggle(activity.id);
            }
          : undefined
      }
      role={expandable ? 'button' : undefined}
      tabIndex={expandable ? 0 : undefined}
      aria-expanded={expandable ? rowExpanded : undefined}
      title={
        expandable
          ? rowExpanded
            ? 'Collapse this step'
            : 'Expand to see the call and its output'
          : undefined
      }
    >
      <span className="agent-tool-icon">
        <AgentActivityIcon activity={activity} />
      </span>
      <span className="agent-tool-text">
        <span className="agent-tool-title-line">
          <span className="agent-tool-title">{title}</span>
          {activity.diff && (
            <span className="agent-tool-chip diff" title={activity.diff.path}>
              <span className="diff-add">+{activity.diff.additions}</span>
              <span className="diff-delete">−{activity.diff.deletions}</span>
            </span>
          )}
          {typeof activity.exitCode === 'number' && activity.exitCode !== 0 && (
            <span className="agent-tool-chip exit">exit {activity.exitCode}</span>
          )}
          {activity.status === 'waiting' && runRunning && (
            <span className="agent-tool-chip waiting">needs approval</span>
          )}
        </span>
        {activity.detail && !detailRepeatsTitle && (
          <span className={`agent-tool-detail${rowExpanded ? ' expanded' : ''}`}>
            {rowExpanded ? activity.detail : collapsedDetailPreview(activity)}
          </span>
        )}
        {showInput && (
          <div className="agent-tool-io" onClick={(event) => event.stopPropagation()}>
            <span className="agent-tool-io-label">Called with</span>
            <pre className="agent-tool-output input">{activity.input}</pre>
          </div>
        )}
        {showOutput && outputText && (
          <div
            className="agent-tool-io"
            onClick={rowExpanded ? (event) => event.stopPropagation() : undefined}
          >
            {rowExpanded && <span className="agent-tool-io-label">Output</span>}
            <pre className="agent-tool-output">{outputText}</pre>
          </div>
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
                  event.stopPropagation();
                  void window.orion?.openExternalUrl?.(source.url);
                }}
              >
                {hostnameForUrl(source.url)}
              </a>
            ))}
          </span>
        )}
      </span>
      {expandable && (
        <span className="agent-tool-chevron">
          <ChevronRight size={14} />
        </span>
      )}
    </div>
  );
});

// A run's steps as a flat list (T3 Code style): one row per step, no card.
// Expandable rows open in place to show the call and its output.
export const AgentActivityCard: React.FC<{
  activities: AgentActivity[];
  runStatus?: Message['status'];
  runRunning?: boolean;
}> = ({ activities, runStatus, runRunning = runStatus === 'running' }) => {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());

  const toggleRow = useCallback(
    (id: string) =>
      setExpandedRows((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    []
  );

  if (activities.length === 0) return null;

  return (
    <div className="agent-steps">
      {activities.map((activity) => (
        <AgentActivityRow
          key={activity.id}
          activity={activity}
          runRunning={runRunning}
          rowExpanded={isExpandableActivity(activity) && expandedRows.has(activity.id)}
          onToggle={toggleRow}
        />
      ))}
    </div>
  );
};

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
