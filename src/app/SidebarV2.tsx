import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  MessageCircleQuestion,
  MonitorSmartphone,
  Ellipsis,
  FolderPlus,
  GitBranch,
  History,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { findProjectById, isNoProjectId, NO_PROJECT_NAME, type Project, type Thread } from '../store';
import { agentProviders } from '../agentCatalog';
import { InlineRenameInput } from './fileTree';
import { ProjectBadge } from './ProjectBadge';
import { SidebarFooter, type SidebarFooterProps } from './SidebarFooter';
import { SidebarSearchPanel, warmSearchIndex } from './threadSearch';
import { formatShortTime, getThreadActivityTime } from './time';
import { useSidebarResize } from './useSidebarResize';
import { THREAD_DRAG_MIME } from './AgentsSidebar';
import { formatWorkedDuration, threadSidebarTone, threadWorkedMs, type SidebarV2Lists, type SidebarV2View, type SidebarV2ViewsSettings } from './threadLists';
import ThemeSlot from './themes/ThemeSlot';

// Sidebar v2 (Settings → Experimental), after T3 Code's: one flat list of
// threads instead of project groups. The header holds search, New agent, Add
// project and a views menu that toggles Pinned, Working, Snoozed and Settled.
// A row can be snoozed (it leaves the list until its run finishes or it needs
// you) or settled (archived until you restore it or send it a new message).

const PAGE_SIZE = 40;
const AGENTS_SIDEBAR_STORAGE_KEY = 'orion.agentsSidebarWidth';
const HOVER_CARD_DELAY_MS = 550;

const VIEW_LABELS: Record<SidebarV2View, string> = {
  pinned: 'Pinned',
  working: 'Working',
  recent: 'Recent',
  snoozed: 'Snoozed',
  settled: 'Settled',
};
// Sections in sidebar order. Recent (every thread you haven't snoozed or
// settled, pinned ones included) is always shown; the menu toggles the others.
const VIEW_ORDER: SidebarV2View[] = ['pinned', 'working', 'recent', 'snoozed', 'settled'];
const TOGGLEABLE_VIEWS: SidebarV2View[] = ['pinned', 'working', 'snoozed', 'settled'];
const VIEW_EMPTY_LABELS: Record<SidebarV2View, string> = {
  pinned: 'Nothing pinned',
  working: 'Nothing running',
  recent: 'No threads yet',
  snoozed: 'Nothing snoozed',
  settled: 'Nothing settled yet',
};
const VIEW_MENU_HINTS: Partial<Record<SidebarV2View, string>> = {
  pinned: 'Also list pinned threads at the top',
  working: 'Also list every running thread, snoozed ones included',
};

/** Row actions. App passes one stable object so memoized rows skip re-renders. */
export type SidebarV2Actions = {
  selectThread: (id: string | null) => void;
  setActiveTab: (tab: 'agents' | 'code') => void;
  updateThread: (id: string, updates: Partial<Thread>) => void;
  branchThread: (sourceThreadId: string) => Promise<string | null>;
  pinThread: (threadId: string) => void;
  unpinThread: (threadId: string) => void;
  snoozeThread: (threadId: string) => void;
  unsnoozeThread: (threadId: string) => void;
  settleThread: (threadId: string) => void;
  unsettleThread: (threadId: string) => void;
  deleteThreadWithRuntime: (threadId: string) => Promise<void>;
  /** A thread on another machine is likely to be opened: read its copy now. */
  readAheadRemoteThread: (threadId: string) => void;
  modelLabel: (thread: Thread) => string | null;
  renderThreadCliBadge: (thread: Thread) => React.JSX.Element | null;
};

export type SidebarV2Model = {
  actions: SidebarV2Actions;
  projects: Project[];
  noProject: Project | null;
  selectedThreadId: string | null;
  paneThreadIds: string[];
  /** Thread lists per view, already filtered and ordered. */
  threadsByView: SidebarV2Lists;
  views: SidebarV2ViewsSettings;
  setViewVisible: (view: SidebarV2View, visible: boolean) => void;
  /** Threads with a question or approval waiting on the user. */
  attentionThreadIds: ReadonlyMap<string, number>;
  /** A project picked in search: v2 starts a new thread there. */
  selectProject: (id: string) => void;
  handleNewAgent: () => void;
  handleAddProject: () => void;
  threadSearchOpen: boolean;
  setThreadSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  threadSearchRef: React.RefObject<HTMLDivElement | null>;
  /** Machines and saved views, rendered above the threads when present. */
  extraSections?: React.ReactNode;
  sidebarFooterProps: SidebarFooterProps;
};

// Dropdown / popover close-on-outside-click and Escape.
const useDismiss = (open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) => {
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, open, ref]);
};

const HeaderIconButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }
> = ({ label, active, className, children, ...rest }) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors duration-100 hover:bg-white/[0.07] hover:text-neutral-100 ${
      active ? 'bg-white/[0.08] text-neutral-100' : ''
    } ${className ?? ''}`}
    {...rest}
  >
    {children}
  </button>
);

const ViewsMenu: React.FC<{
  views: SidebarV2ViewsSettings;
  counts: Record<SidebarV2View, number>;
  setViewVisible: (view: SidebarV2View, visible: boolean) => void;
}> = ({ views, counts, setViewVisible }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  return (
    <div className="relative" ref={ref}>
      <HeaderIconButton
        label="Show threads"
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <History size={15} />
      </HeaderIconButton>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-[200px] animate-[sidebar-menu-in_120ms_cubic-bezier(0.22,1,0.36,1)] rounded-xl border border-white/10 bg-[rgb(24_24_27_/_0.98)] p-1 shadow-[0_16px_48px_rgb(0_0_0_/_0.5)] backdrop-blur-md"
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-neutral-500">Show in sidebar</div>
          {TOGGLEABLE_VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              role="menuitemcheckbox"
              aria-checked={views[view]}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-neutral-200 transition-colors duration-75 hover:bg-white/[0.07]"
              onClick={() => setViewVisible(view, !views[view])}
            >
              <span
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-100 ${
                  views[view] ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-white/20'
                }`}
              >
                {views[view] && <Check size={11} strokeWidth={3} />}
              </span>
              <span className="flex-1" title={VIEW_MENU_HINTS[view]}>
                {VIEW_LABELS[view]}
              </span>
              <span className="text-[12px] tabular-nums text-neutral-500">{counts[view]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

type RowMenuAction = {
  key: string;
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
  run: () => void;
};

const ThreadRowMenu: React.FC<{ actions: RowMenuAction[]; label: string; onOpenChange: (open: boolean) => void }> = ({
  actions,
  label,
  onOpenChange,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const setMenuOpen = useCallback(
    (value: boolean) => {
      setOpen(value);
      onOpenChange(value);
    },
    [onOpenChange]
  );
  const close = useCallback(() => setMenuOpen(false), [setMenuOpen]);
  useDismiss(open, ref, close);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title="Thread options"
        aria-label={`Options for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-white/[0.08] hover:text-neutral-100"
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen(!open);
        }}
      >
        <Ellipsis size={14} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+4px)] z-50 w-[180px] animate-[sidebar-menu-in_120ms_cubic-bezier(0.22,1,0.36,1)] rounded-xl border border-white/10 bg-[rgb(24_24_27_/_0.98)] p-1 shadow-[0_16px_48px_rgb(0_0_0_/_0.5)] backdrop-blur-md"
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors duration-75 hover:bg-white/[0.07] ${
                action.danger ? 'text-red-300 hover:bg-red-500/10' : 'text-neutral-200'
              }`}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                action.run();
              }}
            >
              <span className="flex w-3.5 justify-center text-neutral-400">{action.icon}</span>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const HOVER_CARD_WIDTH = 300;
const HOVER_CARD_GAP = 8;

const ThreadHoverCard: React.FC<{
  anchor: DOMRect;
  thread: Thread;
  project: Project | undefined;
  modelLabel: string | null;
}> = ({ anchor, thread, project, modelLabel }) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.right + HOVER_CARD_GAP, top: anchor.top });
  // Beside the row: to its right in the sidebar; where a row is too wide for
  // that (Sidebar v3's project page), to its left, else below it. Always
  // inside the window.
  useLayoutEffect(() => {
    const height = cardRef.current?.offsetHeight ?? 0;
    const width = cardRef.current?.offsetWidth ?? HOVER_CARD_WIDTH;
    const margin = 8;
    const clampTop = (value: number) => Math.max(margin, Math.min(value, window.innerHeight - height - margin));
    if (anchor.right + HOVER_CARD_GAP + width + margin <= window.innerWidth) {
      setPosition({ left: anchor.right + HOVER_CARD_GAP, top: clampTop(anchor.top) });
    } else if (anchor.left - HOVER_CARD_GAP - width >= margin) {
      setPosition({ left: anchor.left - HOVER_CARD_GAP - width, top: clampTop(anchor.top) });
    } else {
      const below = anchor.bottom + 6 + height + margin <= window.innerHeight;
      setPosition({
        left: Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin)),
        top: clampTop(below ? anchor.bottom + 6 : anchor.top - height - 6),
      });
    }
  }, [anchor.top, anchor.left, anchor.right, anchor.bottom]);
  const status =
    thread.status === 'running'
      ? 'Working'
      : thread.status === 'error'
        ? 'Stopped with an error'
        : thread.snoozedAt
          ? 'Snoozed'
          : thread.settledAt
            ? 'Settled'
            : null;
  return createPortal(
    <div
      ref={cardRef}
      role="tooltip"
      className="pointer-events-none fixed z-[1050] w-[300px] max-w-[calc(100vw-16px)] animate-[sidebar-menu-in_140ms_cubic-bezier(0.22,1,0.36,1)] rounded-xl border border-white/10 bg-[rgb(20_20_22_/_0.98)] px-3.5 py-3 text-neutral-200 shadow-[0_16px_48px_rgb(0_0_0_/_0.55)] backdrop-blur-md"
      style={position}
    >
      <div className="text-[13px] font-semibold leading-snug text-neutral-100">{thread.title}</div>
      <div className="mt-2 flex flex-col gap-1.5 text-[12px] text-neutral-400">
        <div className="flex min-w-0 items-center gap-2">
          {project && !isNoProjectId(project.id) ? (
            <ProjectBadge project={project} size={14} />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0 rounded-[4px] border border-dashed border-neutral-500" />
          )}
          <span className="truncate">
            {project && !isNoProjectId(project.id) ? project.name : (thread.remote?.projectName ?? NO_PROJECT_NAME)}
          </span>
        </div>
        {modelLabel && (
          <div className="flex items-center gap-2">
            <span className="flex w-3.5 justify-center">
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-500" />
            </span>
            <span className="truncate">{modelLabel}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Clock size={13} className="shrink-0" />
          <span className="truncate">
            {threadWorkedMs(thread) > 0 ? `Worked ${formatWorkedDuration(threadWorkedMs(thread))} · ` : ''}
            {lastActiveLabel(thread)}
          </span>
        </div>
        {thread.remote && (
          <div className="flex items-center gap-2">
            <MonitorSmartphone size={13} className="shrink-0" />
            <span className="truncate">Runs on {thread.remote.machineName}</span>
          </div>
        )}
        {thread.durangoWorkspace && (
          <div className="flex items-center gap-2">
            <GitBranch size={13} className="shrink-0" />
            <span className="truncate">Workspace {thread.durangoWorkspace.name}</span>
          </div>
        )}
      </div>
      {status && <div className="mt-2.5 border-t border-white/[0.06] pt-2 text-[12px] text-neutral-400">{status}</div>}
    </div>,
    document.body
  );
};

// Snoozing or settling a row slides the next one under the pointer, with its
// own Snooze/Settle in the same spot, so quick repeated clicks would put away
// thread after thread. A put-away click right after another is ignored.
const PUT_AWAY_REPEAT_GUARD_MS = 400;
let lastPutAwayAt = 0;
const putAwayOnce = (putAway: () => void) => {
  const now = Date.now();
  if (now - lastPutAwayAt < PUT_AWAY_REPEAT_GUARD_MS) return;
  lastPutAwayAt = now;
  putAway();
};

export type ThreadRowProps = {
  thread: Thread;
  view: SidebarV2View;
  project: Project | undefined;
  selected: boolean;
  inSplit: boolean;
  needsAttention: boolean;
  renaming: boolean;
  actions: SidebarV2Actions;
  onStartRename: (threadId: string) => void;
  onEndRename: () => void;
  /** The hover card at the pointer instead of beside the row (wide rows, e.g. Sidebar v3's project page). */
  hoverAtPointer?: boolean;
};

// Also Sidebar v3's project page threads (BotsWorkspace.tsx).
export const ThreadRow = React.memo(function ThreadRow({
  thread,
  view,
  project,
  selected,
  inSplit,
  needsAttention,
  renaming,
  actions: model,
  onStartRename,
  onEndRename,
  hoverAtPointer = false,
}: ThreadRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hoverAnchor, setHoverAnchor] = useState<DOMRect | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  // The card's anchor: the row, or a point just off the pointer.
  const hoverAnchorNow = () => {
    const pointer = pointerRef.current;
    if (hoverAtPointer && pointer) return new DOMRect(pointer.x + 6, pointer.y + 10, 0, 0);
    return rowRef.current?.getBoundingClientRect() ?? null;
  };
  const hoverTimerRef = useRef<number | null>(null);
  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  };
  useEffect(() => clearHoverTimer, []);

  const tone = threadSidebarTone(thread, needsAttention);
  // A running thread keeps its Working label on hover and focus, and can't be
  // settled until its run ends (snoozing it is fine: it wakes when it ends).
  const running = thread.status === 'running';
  // As in T3: the row's number is how long the thread's agents have worked.
  const workedMs = useMemo(() => threadWorkedMs(thread), [thread]);
  const statusLabel =
    thread.status === 'running' || tone || needsAttention ? (
      <ThreadStatusLabel thread={thread} tone={tone} needsInput={needsAttention} />
    ) : null;
  // Settled threads recede until hovered, as in T3 (also in Pinned).
  const recede = !!thread.settledAt && !selected;
  const isNoProject = !project || isNoProjectId(project.id);
  // Another machine's thread whose project isn't here: its name there.
  const projectName = isNoProject ? (thread.remote?.projectName ?? NO_PROJECT_NAME) : project.name;

  const menuActions: (RowMenuAction | null)[] = [
    { key: 'rename', label: 'Rename', icon: <SquarePen size={13} />, run: () => onStartRename(thread.id) },
    { key: 'branch', label: 'Branch', icon: <GitBranch size={13} />, run: () => model.branchThread(thread.id) },
    thread.pinnedAt
      ? { key: 'unpin', label: 'Unpin', icon: <PinOff size={13} />, run: () => model.unpinThread(thread.id) }
      : { key: 'pin', label: 'Pin', icon: <Pin size={13} />, run: () => model.pinThread(thread.id) },
    thread.snoozedAt
      ? { key: 'unsnooze', label: 'Unsnooze', icon: <AlarmClock size={13} />, run: () => model.unsnoozeThread(thread.id) }
      : { key: 'snooze', label: 'Snooze', icon: <Clock size={13} />, run: () => model.snoozeThread(thread.id) },
    thread.settledAt
      ? {
          key: 'unsettle',
          label: 'Restore',
          icon: <ArchiveRestore size={13} />,
          run: () => model.unsettleThread(thread.id),
        }
      : running
        ? null
        : { key: 'settle', label: 'Settle', icon: <Archive size={13} />, run: () => model.settleThread(thread.id) },
    {
      key: 'delete',
      label: 'Delete',
      icon: <Trash2 size={13} />,
      danger: true,
      run: () => {
        if (confirm('Delete this thread?')) void model.deleteThreadWithRuntime(thread.id);
      },
    },
  ];
  const actions = menuActions.filter((action): action is RowMenuAction => action !== null);

  const toneClass =
    tone === 'attention'
      ? 'bg-amber-400/[0.09] hover:bg-amber-400/[0.13]'
      : tone === 'finished'
        ? 'bg-emerald-400/[0.08] hover:bg-emerald-400/[0.12]'
        : selected
          ? 'bg-white/[0.08]'
          : 'hover:bg-white/[0.045]';
  const selectedRing = selected && tone ? 'ring-1 ring-inset ring-white/[0.12]' : '';

  // Hover actions replace the time: snooze/settle for live threads, wake /
  // restore inside the Snoozed and Settled views (and for a settled thread
  // that stays in Pinned, or a snoozed one listed under Working).
  const quickActions =
    view === 'settled' || thread.settledAt ? (
      <QuickAction label="Restore to sidebar" onClick={() => model.unsettleThread(thread.id)}>
        <ArchiveRestore size={13} />
        <span>Restore</span>
      </QuickAction>
    ) : view === 'snoozed' || thread.snoozedAt ? (
      <>
        <QuickAction label="Unsnooze thread" onClick={() => model.unsnoozeThread(thread.id)} iconOnly>
          <AlarmClock size={13} />
        </QuickAction>
        {!running && (
          <QuickAction label="Settle thread" onClick={() => putAwayOnce(() => model.settleThread(thread.id))}>
            <Check size={13} />
            <span>Settle</span>
          </QuickAction>
        )}
      </>
    ) : (
      <>
        <QuickAction label="Snooze thread" onClick={() => putAwayOnce(() => model.snoozeThread(thread.id))} iconOnly>
          <Clock size={13} />
        </QuickAction>
        {!running && (
          <QuickAction label="Settle thread" onClick={() => putAwayOnce(() => model.settleThread(thread.id))}>
            <Check size={13} />
            <span>Settle</span>
          </QuickAction>
        )}
      </>
    );

  return (
    <div
      ref={rowRef}
      className={`group relative mx-1.5 cursor-pointer rounded-lg px-2.5 py-[7px] transition-colors duration-100 ${toneClass} ${selectedRing} ${
        menuOpen ? 'bg-white/[0.06]' : ''
      }`}
      draggable={!renaming}
      onDragStart={(event) => {
        clearHoverTimer();
        setHoverAnchor(null);
        event.dataTransfer.setData(THREAD_DRAG_MIME, thread.id);
        event.dataTransfer.setData('text/plain', thread.id);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onMouseEnter={(event) => {
        clearHoverTimer();
        pointerRef.current = { x: event.clientX, y: event.clientY };
        // Hovered on the way to a click: another machine's thread starts
        // loading now, so it opens current.
        if (thread.remote) model.readAheadRemoteThread(thread.id);
        hoverTimerRef.current = window.setTimeout(() => {
          setHoverAnchor(hoverAnchorNow());
        }, HOVER_CARD_DELAY_MS);
      }}
      onMouseMove={
        hoverAtPointer
          ? (event) => {
              pointerRef.current = { x: event.clientX, y: event.clientY };
              // Shown already: it follows the pointer.
              if (hoverAnchor) setHoverAnchor(hoverAnchorNow());
            }
          : undefined
      }
      onMouseLeave={() => {
        clearHoverTimer();
        setHoverAnchor(null);
      }}
      onMouseDown={() => {
        clearHoverTimer();
        setHoverAnchor(null);
      }}
      onClick={() => {
        if (renaming) return;
        model.selectThread(thread.id);
        model.setActiveTab('agents');
      }}
      onKeyDown={(event) => {
        if (renaming || event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          model.selectThread(thread.id);
          model.setActiveTab('agents');
        }
      }}
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
    >
      {inSplit && !selected && (
        <span className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-[rgb(77_141_255_/_0.6)]" aria-hidden />
      )}
      {selected && <span className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-[var(--accent)]" aria-hidden />}
      <div className="flex h-[18px] items-center gap-1.5">
        {isNoProject ? (
          <span className="h-[14px] w-[14px] shrink-0 rounded-[4px] border border-dashed border-neutral-600" aria-hidden />
        ) : (
          <ProjectBadge project={project} size={14} />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-500">{projectName}</span>
        <span
          className={`flex shrink-0 items-center gap-1 ${
            running ? '' : menuOpen ? 'hidden' : 'group-hover:hidden group-focus-within:hidden'
          }`}
        >
          {thread.pinnedAt && view !== 'pinned' && <Pin size={11} className="text-neutral-500" aria-label="Pinned" />}
          {statusLabel ??
            (workedMs > 0 ? (
              <span
                className="text-[11.5px] tabular-nums text-neutral-500"
                title={`Worked ${formatWorkedDuration(workedMs)} · ${lastActiveLabel(thread)}`}
              >
                {formatWorkedDuration(workedMs)}
              </span>
            ) : null)}
        </span>
        <span
          className={`-my-1 shrink-0 items-center gap-0.5 ${menuOpen ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'}`}
          onClick={(event) => event.stopPropagation()}
        >
          {quickActions}
          <ThreadRowMenu actions={actions} label={thread.title} onOpenChange={setMenuOpen} />
        </span>
      </div>
      <div className="mt-[3px] flex min-w-0 items-center gap-1.5">
        {renaming ? (
          <InlineRenameInput
            className="thread-rename-input"
            initialValue={thread.title}
            onSubmit={(title) => {
              model.updateThread(thread.id, { title });
              onEndRename();
            }}
            onCancel={onEndRename}
          />
        ) : (
          <>
            <span
              className={`min-w-0 flex-1 truncate text-[13.5px] leading-[18px] ${
                selected
                  ? 'text-white'
                  : recede
                    ? 'text-neutral-400 group-hover:text-neutral-200'
                    : tone
                      ? 'font-medium text-neutral-100'
                      : 'text-neutral-200'
              }`}
            >
              {thread.title}
            </span>
          </>
        )}
      </div>
      {/* Line 3, as in T3: where it works (the other machine it runs on, or
          its Durango workspace) and which agent runs it. */}
      <div className="mt-[3px] flex h-4 min-w-0 items-center gap-1.5 text-[11.5px] text-neutral-500">
        {thread.remote ? (
          <span className="flex min-w-0 flex-1 items-center gap-1" title={`Runs on ${thread.remote.machineName}`}>
            <MonitorSmartphone size={11} className="shrink-0" />
            <span className="truncate">{thread.remote.machineName}</span>
          </span>
        ) : thread.durangoWorkspace ? (
          <span className="flex min-w-0 flex-1 items-center gap-1" title={thread.durangoWorkspace.path}>
            <GitBranch size={11} className="shrink-0" />
            <span className="truncate">{thread.durangoWorkspace.name}</span>
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {model.renderThreadCliBadge(thread)}
        <ProviderMark modelId={thread.modelId} />
      </div>
      {hoverAnchor && !menuOpen && !renaming && (
        <ThreadHoverCard
          anchor={hoverAnchor}
          thread={thread}
          project={project}
          modelLabel={model.modelLabel(thread)}
        />
      )}
    </div>
  );
});

// Search results pop out of the sidebar at a fixed width, so a narrow sidebar
// doesn't squeeze them. Portaled because the sidebar clips its overflow.
const SEARCH_POPOVER_WIDTH = 520;
const SearchPopover: React.FC<{ anchorRef: React.RefObject<HTMLDivElement | null>; children: React.ReactNode }> = ({
  anchorRef,
  children,
}) => {
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const left = anchor.left + 10;
      const width = Math.max(anchor.width - 20, Math.min(SEARCH_POPOVER_WIDTH, window.innerWidth - left - 12));
      setPosition({ left, top: anchor.bottom - 8, width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef]);
  if (!position) return null;
  return createPortal(
    <div data-thread-search-popover className="fixed z-[1040]" style={position}>
      {children}
    </div>,
    document.body
  );
};

const QuickAction: React.FC<{
  label: string;
  onClick: () => void;
  iconOnly?: boolean;
  children: React.ReactNode;
}> = ({ label, onClick, iconOnly, children }) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    className={`inline-flex h-6 items-center gap-1 rounded-md text-[12px] text-neutral-400 transition-colors duration-75 hover:bg-white/[0.08] hover:text-neutral-100 ${
      iconOnly ? 'w-6 justify-center' : 'px-1.5'
    }`}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
  >
    {children}
  </button>
);

const lastActiveLabel = (thread: Thread) => {
  const ago = formatShortTime(getThreadActivityTime(thread));
  return ago === 'now' ? 'active just now' : `last active ${ago} ago`;
};

// The provider's mark (Claude, Codex, …) from the model id's prefix.
const ProviderMark: React.FC<{ modelId: string }> = ({ modelId }) => {
  const providerId = modelId.split(':')[0];
  const provider = agentProviders.find((candidate) => candidate.id === providerId);
  if (!provider) return null;
  const Icon = provider.icon;
  return (
    <span className="inline-flex shrink-0 opacity-70" title={provider.label} aria-label={provider.label}>
      <Icon size={13} />
    </span>
  );
};

// "Working 12s": time since the user's message, across the turns the agent
// was re-invoked for while it waited on background tasks.
const WorkingDuration: React.FC<{ thread: Thread }> = ({ thread }) => {
  const startedAt = thread.summary.workingSince;
  const [now, setNow] = useState(() => Date.now());
  const valid = startedAt !== null && Number.isFinite(startedAt);
  // Wake only when the label can change: every second under a minute, then
  // at the next minute ("7m" → "8m"). A running thread can sit in several
  // sections at once, each with its own label, so idle ticks add up.
  useEffect(() => {
    if (!valid) return undefined;
    // `now` is from the last tick; when `startedAt` moved meanwhile it can be
    // up to a minute old, so take a fresh one first.
    const current = Date.now();
    if (current - now > 250) {
      setNow(current);
      return undefined;
    }
    const elapsed = Math.max(0, now - (startedAt as number));
    // formatWorkedDuration rounds to whole seconds, so a minute turns over
    // 500ms before its exact boundary.
    const delay =
      elapsed < 59_500 ? 1000 - (elapsed % 1000) : (Math.floor((elapsed + 500) / 60_000) + 1) * 60_000 - 500 - elapsed;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(250, delay));
    return () => window.clearTimeout(timer);
  }, [now, startedAt, valid]);
  if (!valid) return null;
  return <span className="tabular-nums">{formatWorkedDuration(Math.max(0, now - startedAt))}</span>;
};

// Replaces the relative time on a row's first line while the thread has
// something to say: working, done (unopened), or waiting on the user.
const ThreadStatusLabel: React.FC<{ thread: Thread; tone: ReturnType<typeof threadSidebarTone>; needsInput: boolean }> = ({
  thread,
  tone,
  needsInput,
}) => {
  if (needsInput) {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-amber-300">
        <MessageCircleQuestion size={13} className="shrink-0" />
        Needs you
      </span>
    );
  }
  if (thread.status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-sky-400">
        <CircleDashed size={13} className="shrink-0 animate-spin [animation-duration:3s] motion-reduce:animate-none" />
        Working
        <WorkingDuration thread={thread} />
      </span>
    );
  }
  if (tone === 'attention') {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-amber-300">
        {thread.wokeReason ? <AlarmClock size={12} className="shrink-0" /> : <CircleAlert size={12} className="shrink-0" />}
        {thread.status === 'error' ? 'Failed' : 'Needs you'}
      </span>
    );
  }
  if (tone === 'finished') {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-emerald-400">
        <CircleCheck size={12} className="shrink-0" />
        Done
      </span>
    );
  }
  return null;
};

export const SidebarV2 = React.memo(function SidebarV2(model: SidebarV2Model) {
  const { selectThread, setActiveTab } = model.actions;
  const {
    actions,
    projects,
    noProject,
    selectedThreadId,
    paneThreadIds,
    threadsByView,
    views,
    setViewVisible,
    attentionThreadIds,
    handleNewAgent,
    handleAddProject,
    threadSearchOpen,
    setThreadSearchOpen,
    threadSearchRef,
    selectProject,
    extraSections,
    sidebarFooterProps,
  } = model;

  const { sidebarRef, resizeHandle } = useSidebarResize({
    storageKey: AGENTS_SIDEBAR_STORAGE_KEY,
    label: 'Agents sidebar',
  });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [limits, setLimits] = useState<Record<SidebarV2View, number>>({
    pinned: PAGE_SIZE,
    working: PAGE_SIZE,
    recent: PAGE_SIZE,
    snoozed: PAGE_SIZE,
    settled: PAGE_SIZE,
  });
  const endRename = useCallback(() => setRenamingId(null), []);

  const counts = {
    pinned: threadsByView.pinned.length,
    working: threadsByView.working.length,
    recent: threadsByView.recent.length,
    snoozed: threadsByView.snoozed.length,
    settled: threadsByView.settled.length,
  };
  // Search labels No project threads too.
  const searchProjects = useMemo(() => (noProject ? [...projects, noProject] : projects), [noProject, projects]);
  // Recent always shows. An empty Pinned group is hidden; Working, Snoozed and Settled were
  // turned on deliberately, so they say they're empty instead.
  const shownViews = VIEW_ORDER.filter((view) =>
    view === 'recent' ? true : view === 'pinned' ? views.pinned && threadsByView.pinned.length > 0 : views[view]
  );
  const projectLookup = { projects, noProject };

  const handleSearchSelectThread = useCallback(
    (threadId: string) => {
      selectThread(threadId);
      setActiveTab('agents');
      setThreadSearchOpen(false);
    },
    [selectThread, setActiveTab, setThreadSearchOpen]
  );
  const handleSearchSelectProject = useCallback(
    (projectId: string) => {
      selectProject(projectId);
      setActiveTab('agents');
      setThreadSearchOpen(false);
    },
    [selectProject, setActiveTab, setThreadSearchOpen]
  );

  return (
    <div className="sidebar agents-sidebar" ref={sidebarRef}>
      {/* The header row anchors the search results. */}
      <div className="sidebar-top-row relative flex items-center gap-1 px-2.5 pb-2 pt-2.5" ref={threadSearchRef}>
        <button
          type="button"
          className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors duration-100 ${
            threadSearchOpen
              ? 'bg-white/[0.08] text-neutral-100'
              : 'text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200'
          }`}
          onClick={() => setThreadSearchOpen((open) => !open)}
          onPointerEnter={warmSearchIndex}
          onFocus={warmSearchIndex}
          aria-expanded={threadSearchOpen}
        >
          <Search size={15} className="shrink-0" />
          <span className="truncate">Search</span>
        </button>
        {threadSearchOpen && (
          <SearchPopover anchorRef={threadSearchRef}>
            <SidebarSearchPanel
              projects={searchProjects}
              onSelectThread={handleSearchSelectThread}
              onSelectProject={handleSearchSelectProject}
            />
          </SearchPopover>
        )}
        <HeaderIconButton
          label="New agent"
          onClick={() => {
            setThreadSearchOpen(false);
            handleNewAgent();
          }}
        >
          <SquarePen size={15} />
        </HeaderIconButton>
        <HeaderIconButton
          label="Add project"
          onClick={() => {
            setThreadSearchOpen(false);
            handleAddProject();
          }}
        >
          <FolderPlus size={15} />
        </HeaderIconButton>
        <ViewsMenu views={views} counts={counts} setViewVisible={setViewVisible} />
        <ThemeSlot name="sidebar-top" />
      </div>

      <div className="sidebar-content agents-sidebar-content !pt-0">
        {extraSections}
        {shownViews.map((view) => {
          const threads = threadsByView[view];
          const limit = limits[view];
          const showHeader = shownViews.length > 1 || view !== 'recent';
          return (
            <section key={view} className="mb-2" aria-label={VIEW_LABELS[view]}>
              {showHeader && (
                <div className="flex items-center justify-between px-4 pb-1 pt-2 text-[11.5px] font-medium text-neutral-500">
                  <span>{VIEW_LABELS[view]}</span>
                  {threads.length > 0 && <span className="tabular-nums">{threads.length}</span>}
                </div>
              )}
              {threads.length === 0 ? (
                <div className="px-4 py-1.5 text-[12.5px] text-neutral-600">
                  {VIEW_EMPTY_LABELS[view]}
                </div>
              ) : (
                <div className="flex flex-col gap-px">
                  {threads.slice(0, limit).map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      view={view}
                      project={findProjectById(projectLookup, thread.projectId)}
                      selected={selectedThreadId === thread.id}
                      inSplit={paneThreadIds.length > 1 && paneThreadIds.includes(thread.id)}
                      needsAttention={attentionThreadIds.has(thread.id)}
                      renaming={renamingId === thread.id}
                      actions={actions}
                      onStartRename={setRenamingId}
                      onEndRename={endRename}
                    />
                  ))}
                </div>
              )}
              {threads.length > limit && (
                <button
                  type="button"
                  className="mx-1.5 mt-1 rounded-lg px-2.5 py-1.5 text-[12.5px] text-neutral-500 transition-colors hover:bg-white/[0.045] hover:text-neutral-300"
                  onClick={() => setLimits((prev) => ({ ...prev, [view]: prev[view] + PAGE_SIZE }))}
                >
                  Show more ({threads.length - limit})
                </button>
              )}
            </section>
          );
        })}
      </div>
      <SidebarFooter {...sidebarFooterProps} />
      {resizeHandle}
    </div>
  );
});
