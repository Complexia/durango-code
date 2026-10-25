import React, { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  ChevronRight,
  Columns2,
  Ellipsis,
  EyeOff,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Monitor,
  MonitorSmartphone,
  Pin,
  PinOff,
  Plus,
  Search,
  SquareKanban,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import { isNoProjectId, type Epic, type Project, type SavedView, type Thread } from '../store';
import type { RemoteMachineEntry } from '../types';
import { ProjectIcon } from './ProjectIcon';
import { InlineRenameInput } from './fileTree';
import { SidebarSearchPanel, warmSearchIndex } from './threadSearch';
import { formatShortTime, getThreadActivityTime } from './time';
import { SidebarFooter, type SidebarFooterProps } from './SidebarFooter';
import { useSidebarResize } from './useSidebarResize';
import type { EpicPrStatus } from './appTypes';

const THREADS_VISIBLE_LIMIT = 5;
const EMPTY_EPICS: Epic[] = [];
const AGENTS_SIDEBAR_STORAGE_KEY = 'orion.agentsSidebarWidth';

export type AgentsSidebarModel = {
  projects: Project[];
  selectThread: (id: string | null) => void;
  setActiveTab: (tab: 'agents' | 'code') => void;
  selectedThreadId: string | null;
  /** Threads open as panes in the main view; marked in every thread list. */
  paneThreadIds: string[];
  /** Splits the user can return to. The section is hidden while this is empty. */
  savedViews: SavedView[];
  activeSavedViewId: string | null;
  /** Titles for the threads a saved view points at, for its hover list. */
  threadTitlesById: Map<string, string>;
  openSavedView: (id: string) => void;
  deleteSavedView: (id: string) => void;
  savedViewsSectionOpen: boolean;
  setSavedViewsSectionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  updateThread: (id: string, updates: Partial<Thread>) => void;
  branchThread: (sourceThreadId: string) => string | null;
  selectedEpicId: string | null;
  renameEpic: (id: string, name: string) => void;
  selectEpic: (id: string | null) => void;
  renameProject: (id: string, name: string) => void;
  selectProject: (id: string | null) => void;
  threadSearchOpen: boolean;
  setThreadSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  projectMenuOpenId: string | null;
  setProjectMenuOpenId: React.Dispatch<React.SetStateAction<string | null>>;
  threadItemMenuKey: string | null;
  setThreadItemMenuKey: React.Dispatch<React.SetStateAction<string | null>>;
  threadRenameKey: string | null;
  setThreadRenameKey: React.Dispatch<React.SetStateAction<string | null>>;
  projectRenameId: string | null;
  setProjectRenameId: React.Dispatch<React.SetStateAction<string | null>>;
  threadListLimits: Record<string, number>;
  setThreadListLimits: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  collapsedProjects: Record<string, boolean>;
  setCollapsedProjects: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setRecentAgentsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  recentAgentsOpen: boolean;
  setRecentAgentsShowAll: React.Dispatch<React.SetStateAction<boolean>>;
  recentAgentsShowAll: boolean;
  setPinnedAgentsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  pinnedAgentsOpen: boolean;
  setPinnedAgentsShowAll: React.Dispatch<React.SetStateAction<boolean>>;
  pinnedAgentsShowAll: boolean;
  setEpicsSectionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  epicsSectionOpen: boolean;
  collapsedEpics: Record<string, boolean>;
  setCollapsedEpics: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  epicMenuOpenId: string | null;
  setEpicMenuOpenId: React.Dispatch<React.SetStateAction<string | null>>;
  epicRenameId: string | null;
  setEpicRenameId: React.Dispatch<React.SetStateAction<string | null>>;
  threadSearchRef: React.RefObject<HTMLDivElement | null>;
  projectMenuRef: React.RefObject<HTMLDivElement | null>;
  threadItemMenuRef: React.RefObject<HTMLDivElement | null>;
  epicMenuRef: React.RefObject<HTMLDivElement | null>;
  selectedProject: Project | null;
  sortedProjects: Project[];
  recentAgentsTargetProject: Project;
  pinnedThreads: Thread[];
  recentThreads: Thread[];
  pinThread: (threadId: string) => void;
  unpinThread: (threadId: string) => void;
  runningAgentCount: number;
  projectThreadsByProject: Map<string, Thread[]>;
  epicsEnabled: boolean;
  activeEpics: Epic[];
  threadsByEpic: Map<string, Thread[]>;
  runningAgentEpicIds: Set<string>;
  projectForGitRoot: (gitRoot: string | undefined, preferredProjectId?: string) => Project | null;
  deleteThreadWithRuntime: (threadId: string) => Promise<void>;
  removeProjectWithRuntimes: (projectId: string) => Promise<void>;
  handleAddProject: (options?: {
    createInitialThread?: boolean;
    expectedGitRoot?: string;
  }) => Promise<string | undefined>;
  handleNewAgent: () => void;
  handleCreateThread: (projectId: string) => string;
  openCreateEpicModal: () => void;
  handleCreateThreadForEpic: (epic: Epic) => Promise<string | undefined>;
  handleRemoveThreadFromEpic: (threadId: string) => void;
  handleDeleteEpic: (epic: Epic) => void;
  handleSettleEpic: (epic: Epic) => Promise<void>;
  renderThreadCliBadge: (thread: Thread) => React.JSX.Element | null;
  renderThreadStatusDot: (thread: Thread) => React.JSX.Element | null;
  sidebarFooterProps: SidebarFooterProps;
  epicPrStatus: (epic: Pick<Epic, 'prUrl' | 'prState'> | null | undefined) => EpicPrStatus | null;
  /** Machines section (remote control). Hidden entirely while the feature is off. */
  remoteMachinesVisible: boolean;
  machinesSectionOpen: boolean;
  setMachinesSectionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  remoteMachines: RemoteMachineEntry[];
  activeRemoteMachineId: string | null;
  selectRemoteMachine: (machineId: string | null) => void;
  localMachineName: string;
};

// Dragging a sidebar thread onto the main view opens it as an extra pane. The
// payload rides on a private MIME type so the shell's file-drop handling —
// which only looks for 'Files' — stays out of the way, and so a thread dropped
// on anything else (the composer, another app) is simply ignored.
export const THREAD_DRAG_MIME = 'application/x-orion-thread';

const threadDragProps = (threadId: string, renaming: boolean) => ({
  // A draggable ancestor swallows text selection in the rename input, so the
  // row stops being a drag source while it is being renamed.
  draggable: !renaming,
  onDragStart: (event: React.DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(THREAD_DRAG_MIME, threadId);
    // Plain text keeps the drag legible to the OS drag image and to any
    // external drop target the user wanders over.
    event.dataTransfer.setData('text/plain', threadId);
    event.dataTransfer.effectAllowed = 'copy';
  },
});

const ThreadItemSelect = ({
  isRenaming,
  onActivate,
  children,
}: {
  isRenaming: boolean;
  onActivate: () => void;
  children: React.ReactNode;
}) => {
  const className = `thread-item-select ${isRenaming ? 'renaming' : ''}`;
  if (isRenaming) return <div className={className}>{children}</div>;
  return (
    <button type="button" className={className} onClick={onActivate}>
      {children}
    </button>
  );
};

export const AgentsSidebar = React.memo(function AgentsSidebar(props: AgentsSidebarModel) {
  const {
    projects,
    selectThread,
    setActiveTab,
    selectedThreadId,
    paneThreadIds,
    savedViews,
    activeSavedViewId,
    threadTitlesById,
    openSavedView,
    deleteSavedView,
    savedViewsSectionOpen,
    setSavedViewsSectionOpen,
    updateThread,
    branchThread,
    selectedEpicId,
    renameEpic,
    selectEpic,
    renameProject,
    selectProject,
    threadSearchOpen,
    setThreadSearchOpen,
    projectMenuOpenId,
    setProjectMenuOpenId,
    threadItemMenuKey,
    setThreadItemMenuKey,
    threadRenameKey,
    setThreadRenameKey,
    projectRenameId,
    setProjectRenameId,
    threadListLimits,
    setThreadListLimits,
    collapsedProjects,
    setCollapsedProjects,
    setRecentAgentsOpen,
    recentAgentsOpen,
    setRecentAgentsShowAll,
    recentAgentsShowAll,
    setPinnedAgentsOpen,
    pinnedAgentsOpen,
    setPinnedAgentsShowAll,
    pinnedAgentsShowAll,
    setEpicsSectionOpen,
    epicsSectionOpen,
    collapsedEpics,
    setCollapsedEpics,
    epicMenuOpenId,
    setEpicMenuOpenId,
    epicRenameId,
    setEpicRenameId,
    threadSearchRef,
    projectMenuRef,
    threadItemMenuRef,
    epicMenuRef,
    selectedProject,
    sortedProjects,
    recentAgentsTargetProject,
    pinnedThreads,
    recentThreads,
    pinThread,
    unpinThread,
    runningAgentCount,
    projectThreadsByProject,
    epicsEnabled,
    activeEpics,
    threadsByEpic,
    runningAgentEpicIds,
    projectForGitRoot,
    deleteThreadWithRuntime,
    removeProjectWithRuntimes,
    handleAddProject,
    handleNewAgent,
    handleCreateThread,
    openCreateEpicModal,
    handleCreateThreadForEpic,
    handleRemoveThreadFromEpic,
    handleDeleteEpic,
    handleSettleEpic,
    renderThreadCliBadge,
    renderThreadStatusDot,
    sidebarFooterProps,
    epicPrStatus,
    remoteMachinesVisible,
    machinesSectionOpen,
    setMachinesSectionOpen,
    remoteMachines,
    activeRemoteMachineId,
    selectRemoteMachine,
    localMachineName,
  } = props;

  const { sidebarRef, resizeHandle: sidebarResizeHandle } = useSidebarResize({
    storageKey: AGENTS_SIDEBAR_STORAGE_KEY,
    label: 'Agents sidebar',
  });

  // A thread can appear in several sidebar sections at once (pinned, recent,
  // its project, its epic); every copy shows the same open/focused state.
  const threadItemClassName = (threadId: string) =>
    `thread-item${selectedThreadId === threadId ? ' selected' : ''}${
      paneThreadIds.includes(threadId) ? ' in-split' : ''
    }`;

  // Picking a project or epic from search scrolls the sidebar to its section
  // and flashes it, so the user lands where it lives rather than just in it.
  const [revealTarget, setRevealTarget] = useState<{ key: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!revealTarget) return undefined;
    // Wait a frame for a just-expanded section to render.
    const frame = window.requestAnimationFrame(() => {
      const element = sidebarRef.current?.querySelector<HTMLElement>(
        `[data-sidebar-reveal="${CSS.escape(revealTarget.key)}"]`
      );
      if (!element) return;
      element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      element.classList.remove('sidebar-reveal-flash');
      void element.offsetWidth; // restart the animation on a repeat pick
      element.classList.add('sidebar-reveal-flash');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [revealTarget, sidebarRef]);

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
      setCollapsedProjects((prev) => (prev[projectId] ? { ...prev, [projectId]: false } : prev));
      setThreadSearchOpen(false);
      setRevealTarget((prev) => ({ key: `project:${projectId}`, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [selectProject, setActiveTab, setCollapsedProjects, setThreadSearchOpen]
  );
  const handleSearchSelectEpic = useCallback(
    (epicId: string) => {
      selectEpic(epicId);
      setActiveTab('agents');
      setEpicsSectionOpen(true);
      setCollapsedEpics((prev) => (prev[epicId] ? { ...prev, [epicId]: false } : prev));
      setThreadSearchOpen(false);
      setRevealTarget((prev) => ({ key: `epic:${epicId}`, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [selectEpic, setActiveTab, setCollapsedEpics, setEpicsSectionOpen, setThreadSearchOpen]
  );

  return (
    <div className="sidebar agents-sidebar" ref={sidebarRef}>
      <div className="sidebar-content agents-sidebar-content">
        <div className="sidebar-primary-actions">
          <button type="button" className="sidebar-action-button primary" onClick={handleNewAgent}>
            <SquarePen size={15} />
            <span>New agent</span>
          </button>
          <div className="sidebar-search-wrap" ref={threadSearchRef}>
            <button
              type="button"
              className={`sidebar-action-button ${threadSearchOpen ? 'active' : ''}`}
              onClick={() => setThreadSearchOpen((open) => !open)}
              onPointerEnter={warmSearchIndex}
              onFocus={warmSearchIndex}
              aria-expanded={threadSearchOpen}
            >
              <Search size={15} />
              <span>Search</span>
            </button>
            {threadSearchOpen && (
              <SidebarSearchPanel
                projects={projects}
                epics={epicsEnabled ? activeEpics : EMPTY_EPICS}
                onSelectThread={handleSearchSelectThread}
                onSelectProject={handleSearchSelectProject}
                onSelectEpic={handleSearchSelectEpic}
              />
            )}
          </div>
        </div>

        {/*
          Machines (remote control): every paired host this instance can drive,
          plus a "this machine" row to switch back. Absent entirely while remote
          control is off or no remote machines are paired.
        */}
        {remoteMachinesVisible && (
          <div className="recent-agents-section machines-section">
            <button
              type="button"
              className="sidebar-section-toggle"
              onClick={() => setMachinesSectionOpen((open) => !open)}
              aria-expanded={machinesSectionOpen}
            >
              <ChevronRight
                size={12}
                className={`sidebar-section-chevron ${machinesSectionOpen ? 'open' : ''}`}
              />
              <span>Machines</span>
            </button>
            {machinesSectionOpen && (
              <div className="threads-list machines-list">
                <div className={`thread-item machine-item${activeRemoteMachineId === null ? ' selected' : ''}`}>
                  <button
                    type="button"
                    className="thread-item-select"
                    onClick={() => selectRemoteMachine(null)}
                    title="Work on this machine"
                  >
                    <Monitor size={13} className="machine-item-icon" />
                    <span className="thread-title">
                      <span className="thread-title-text">{localMachineName || 'This machine'}</span>
                    </span>
                    <span className="machine-status-dot local" />
                  </button>
                </div>
                {remoteMachines.map((machine) => (
                  <div
                    key={machine.id}
                    className={`thread-item machine-item${activeRemoteMachineId === machine.id ? ' selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="thread-item-select"
                      onClick={() => selectRemoteMachine(machine.id)}
                      title={`${machine.name} (${machine.host ? `${machine.host}:${machine.port}` : 'over the internet'}) — ${machine.status}${machine.error ? ` — ${machine.error}` : ''}`}
                    >
                      <MonitorSmartphone size={13} className="machine-item-icon" />
                      <span className="thread-title">
                        <span className="thread-title-text">{machine.name}</span>
                      </span>
                      <span className={`machine-status-dot ${machine.status}`} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/*
          Saved views only exist while there are splits to return to — an empty
          section would be a permanent reminder of a feature the user isn't
          using, so it isn't rendered at all.
        */}
        {savedViews.length > 0 && (
          <div className="recent-agents-section saved-views-section">
            <button
              type="button"
              className="sidebar-section-toggle"
              onClick={() => setSavedViewsSectionOpen((open) => !open)}
              aria-expanded={savedViewsSectionOpen}
            >
              <ChevronRight
                size={12}
                className={`sidebar-section-chevron ${savedViewsSectionOpen ? 'open' : ''}`}
              />
              <span>Saved views</span>
            </button>
            {savedViewsSectionOpen && (
              <div className="threads-list saved-views-list">
                {savedViews.map((view) => {
                  const paneTitles = view.threadIds.map(
                    (threadId) => threadTitlesById.get(threadId) ?? 'Untitled'
                  );
                  return (
                    <div
                      key={view.id}
                      className={`thread-item saved-view-item${
                        activeSavedViewId === view.id ? ' selected' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="thread-item-select"
                        onClick={() => {
                          openSavedView(view.id);
                          setActiveTab('agents');
                        }}
                        title={paneTitles.join('\n')}
                      >
                        <Columns2 size={13} className="saved-view-icon" />
                        <span className="thread-title">
                          <span className="thread-title-text">{view.name}</span>
                        </span>
                        {/* thread-meta: fades out on hover so the delete
                            button has the row's right edge to itself. */}
                        <span className="sidebar-section-count thread-meta">
                          {view.threadIds.length}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="saved-view-remove"
                        title="Delete this saved view — its threads stay"
                        aria-label={`Delete saved view ${view.name}`}
                        onClick={() => deleteSavedView(view.id)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {pinnedThreads.length > 0 && (
          <div className="recent-agents-section">
            <button
              type="button"
              className="sidebar-section-toggle"
              onClick={() =>
                setPinnedAgentsOpen((open) => {
                  // Collapsing resets the list back to the default 5 on next expand.
                  if (open) setPinnedAgentsShowAll(false);
                  return !open;
                })
              }
              aria-expanded={pinnedAgentsOpen}
            >
              <ChevronRight size={12} className={`sidebar-section-chevron ${pinnedAgentsOpen ? 'open' : ''}`} />
              <span>Pinned</span>
            </button>
            {pinnedAgentsOpen && (
              <>
                <div className="threads-list recent-agents-list">
                  {(pinnedAgentsShowAll ? pinnedThreads : pinnedThreads.slice(0, THREADS_VISIBLE_LIMIT)).map(
                    (thread) => (
                      <div
                        key={thread.id}
                        className={threadItemClassName(thread.id)}
                        {...threadDragProps(thread.id, threadRenameKey === `pinned:${thread.id}`)}
                      >
                        <ThreadItemSelect
                          isRenaming={threadRenameKey === `pinned:${thread.id}`}
                          onActivate={() => selectThread(thread.id)}
                        >
                          {renderThreadStatusDot(thread)}
                          {threadRenameKey === `pinned:${thread.id}` ? (
                            <InlineRenameInput
                              className="thread-rename-input"
                              initialValue={thread.title}
                              onSubmit={(title) => {
                                updateThread(thread.id, { title });
                                setThreadRenameKey(null);
                              }}
                              onCancel={() => setThreadRenameKey(null)}
                            />
                          ) : (
                            <span className="thread-title">
                              {renderThreadCliBadge(thread)}
                              <span className="thread-title-text" title={thread.title}>{thread.title}</span>
                            </span>
                          )}
                          <span className="thread-project-tag thread-meta">
                            {projects.find((p) => p.id === thread.projectId)?.name}
                          </span>
                          <span className="thread-time thread-meta">
                            {formatShortTime(getThreadActivityTime(thread))}
                          </span>
                        </ThreadItemSelect>
                        <div
                          className="thread-menu-wrap"
                          ref={threadItemMenuKey === `pinned:${thread.id}` ? threadItemMenuRef : undefined}
                        >
                          <button
                            type="button"
                            className="thread-options-trigger"
                            title="Thread options"
                            aria-label={`Options for ${thread.title}`}
                            aria-haspopup="menu"
                            aria-expanded={threadItemMenuKey === `pinned:${thread.id}`}
                            onClick={() =>
                              setThreadItemMenuKey((open) =>
                                open === `pinned:${thread.id}` ? null : `pinned:${thread.id}`
                              )
                            }
                          >
                            <Ellipsis size={13} />
                          </button>
                          {threadItemMenuKey === `pinned:${thread.id}` && (
                            <div className="thread-menu thread-item-menu" role="menu">
                              <button
                                type="button"
                                className="project-menu-item"
                                role="menuitem"
                                onClick={() => {
                                  setThreadItemMenuKey(null);
                                  setThreadRenameKey(`pinned:${thread.id}`);
                                }}
                              >
                                <SquarePen size={13} /> Rename
                              </button>
                              <button
                                type="button"
                                className="project-menu-item"
                                role="menuitem"
                                onClick={() => {
                                  setThreadItemMenuKey(null);
                                  branchThread(thread.id);
                                }}
                              >
                                <GitBranch size={13} /> Branch
                              </button>
                              <button
                                type="button"
                                className="project-menu-item"
                                role="menuitem"
                                onClick={() => {
                                  setThreadItemMenuKey(null);
                                  unpinThread(thread.id);
                                }}
                              >
                                <PinOff size={13} /> Unpin
                              </button>
                              <button
                                type="button"
                                className="project-menu-item danger"
                                role="menuitem"
                                onClick={() => {
                                  setThreadItemMenuKey(null);
                                  if (confirm('Delete this thread?')) {
                                    void deleteThreadWithRuntime(thread.id);
                                  }
                                }}
                              >
                                <Trash2 size={13} /> Delete
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  )}
                </div>
                {pinnedThreads.length > THREADS_VISIBLE_LIMIT && (
                  <button
                    type="button"
                    className="threads-show-more"
                    onClick={() => setPinnedAgentsShowAll((showAll) => !showAll)}
                  >
                    {pinnedAgentsShowAll ? 'Show less' : 'Show more'}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {epicsEnabled && projects.length > 0 && (
          <div className="recent-agents-section epics-section">
            <div className="epics-section-header">
              <button
                type="button"
                className="sidebar-section-toggle"
                onClick={() => setEpicsSectionOpen((open) => !open)}
                aria-expanded={epicsSectionOpen}
              >
                <ChevronRight size={15} className={`sidebar-section-chevron ${epicsSectionOpen ? 'open' : ''}`} />
                <span>Epics</span>
              </button>
              <button type="button" className="sidebar-section-action" title="New epic" onClick={openCreateEpicModal}>
                <Plus size={15} />
              </button>
            </div>
            {epicsSectionOpen && (
              <>
                {activeEpics.map((epic) => {
                  const epicThreads = threadsByEpic.get(epic.id) ?? [];
                  const epicThreadListKey = `epic:${epic.id}`;
                  const epicVisibleLimit = threadListLimits[epicThreadListKey] ?? THREADS_VISIBLE_LIMIT;
                  const visibleEpicThreads = epicThreads.slice(0, epicVisibleLimit);
                  const hasMoreEpicThreads = epicThreads.length > epicVisibleLimit;
                  const isEpicListExpanded =
                    epicVisibleLimit > THREADS_VISIBLE_LIMIT && epicThreads.length > THREADS_VISIBLE_LIMIT;
                  // The project label sits on the epic row instead of
                  // repeating on every thread under it — but only while
                  // those threads agree on one project, so a mixed epic
                  // keeps its per-thread tags.
                  const epicProjectNames = new Set(
                    epicThreads
                      .map((thread) => projects.find((p) => p.id === thread.projectId)?.name)
                      .filter((name): name is string => Boolean(name))
                  );
                  const explicitlyBoundEpicProject = epic.gitRoot
                    ? projectForGitRoot(epic.gitRoot, epic.repositoryProjectId)
                    : epic.repositoryProjectId
                      ? projects.find((project) => project.id === epic.repositoryProjectId)
                      : undefined;
                  const epicProjectName =
                    epicThreads.length === 0
                      ? explicitlyBoundEpicProject?.name
                      : epicProjectNames.size === 1
                        ? [...epicProjectNames][0]
                        : undefined;
                  const isEpicCollapsed = collapsedEpics[epic.id] ?? false;
                  const isEpicSelected = selectedEpicId === epic.id && !selectedThreadId;
                  const prStatus = epicPrStatus(epic);

                  return (
                    <div key={epic.id} className="project-section epic-section" data-sidebar-reveal={`epic:${epic.id}`}>
                      <div className="project-section-header-row">
                        <button
                          type="button"
                          className="project-collapse-toggle"
                          title={isEpicCollapsed ? 'Expand threads' : 'Collapse threads'}
                          aria-expanded={!isEpicCollapsed}
                          onClick={() => {
                            // Collapsing resets the list back to the default 5 on next expand.
                            if (!isEpicCollapsed) {
                              setThreadListLimits((prev) => {
                                if (!(epicThreadListKey in prev)) return prev;
                                const { [epicThreadListKey]: _removed, ...rest } = prev;
                                return rest;
                              });
                            }
                            setCollapsedEpics((prev) => ({
                              ...prev,
                              [epic.id]: !isEpicCollapsed,
                            }));
                          }}
                        >
                          <ChevronRight
                            size={12}
                            className={`sidebar-section-chevron ${isEpicCollapsed ? '' : 'open'}`}
                          />
                        </button>
                        {epicRenameId === epic.id ? (
                          <div className="project-section-header project-section-header-renaming">
                            <SquareKanban
                              size={13}
                              className={`epic-icon ${prStatus ? `epic-icon--${prStatus}` : ''}`}
                            />
                            <InlineRenameInput
                              className="thread-rename-input"
                              initialValue={epic.name}
                              onSubmit={(name) => {
                                renameEpic(epic.id, name);
                                setEpicRenameId(null);
                              }}
                              onCancel={() => setEpicRenameId(null)}
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            className={`project-section-header epic-section-header ${isEpicSelected ? 'epic-section-header-selected' : ''}`}
                            onClick={() => {
                              selectEpic(epic.id);
                              setActiveTab('agents');
                            }}
                            title={prStatus ? `${epic.name} — PR ${prStatus}` : epic.name}
                          >
                            <SquareKanban
                              size={13}
                              className={`epic-icon ${prStatus ? `epic-icon--${prStatus}` : ''}`}
                            />
                            {epicProjectName && <span className="epic-project-tag">{epicProjectName}</span>}
                            <span className="truncate">{epic.name}</span>
                            {isEpicCollapsed && epicThreads.length > 0 && (
                              <span className="sidebar-section-count">{epicThreads.length}</span>
                            )}
                          </button>
                        )}
                        <div className="project-menu-wrap" ref={epicMenuOpenId === epic.id ? epicMenuRef : undefined}>
                          <button
                            type="button"
                            className="project-options-trigger"
                            title="Epic options"
                            aria-label={`Options for ${epic.name}`}
                            aria-haspopup="menu"
                            aria-expanded={epicMenuOpenId === epic.id}
                            onClick={() => setEpicMenuOpenId((open) => (open === epic.id ? null : epic.id))}
                          >
                            <Ellipsis size={13} />
                          </button>
                          {epicMenuOpenId === epic.id && (
                            <div className="thread-menu project-menu" role="menu">
                              <button
                                type="button"
                                className="project-menu-item"
                                role="menuitem"
                                onClick={() => {
                                  setEpicMenuOpenId(null);
                                  setEpicRenameId(epic.id);
                                }}
                              >
                                <SquarePen size={13} /> Rename
                              </button>
                              <button
                                type="button"
                                className="project-menu-item"
                                role="menuitem"
                                disabled={runningAgentEpicIds.has(epic.id)}
                                title={
                                  runningAgentEpicIds.has(epic.id)
                                    ? 'Agents are still running in this epic — wait for them to finish before settling it'
                                    : undefined
                                }
                                onClick={() => {
                                  setEpicMenuOpenId(null);
                                  void handleSettleEpic(epic);
                                }}
                              >
                                <Archive size={13} /> Settle
                              </button>
                              <button
                                type="button"
                                className="project-menu-item danger"
                                role="menuitem"
                                onClick={() => {
                                  setEpicMenuOpenId(null);
                                  handleDeleteEpic(epic);
                                }}
                              >
                                <Trash2 size={13} /> Delete
                              </button>
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="project-new-thread"
                          title={`New thread in ${epic.name}`}
                          onClick={() => handleCreateThreadForEpic(epic)}
                        >
                          <SquarePen size={13} />
                        </button>
                      </div>

                      {!isEpicCollapsed && (
                        <>
                          <div className="threads-list">
                            {epicThreads.length === 0 ? (
                            <button
                              type="button"
                              className="thread-item thread-item-empty"
                              onClick={() => handleCreateThreadForEpic(epic)}
                            >
                              <span className="thread-title">New thread</span>
                            </button>
                          ) : (
                            visibleEpicThreads.map((thread) => (
                              <div
                                key={thread.id}
                                className={threadItemClassName(thread.id)}
                                {...threadDragProps(thread.id, threadRenameKey === `epic:${thread.id}`)}
                              >
                                <ThreadItemSelect
                                  isRenaming={threadRenameKey === `epic:${thread.id}`}
                                  onActivate={() => selectThread(thread.id)}
                                >
                                  {renderThreadStatusDot(thread)}
                                  {threadRenameKey === `epic:${thread.id}` ? (
                                    <InlineRenameInput
                                      className="thread-rename-input"
                                      initialValue={thread.title}
                                      onSubmit={(title) => {
                                        updateThread(thread.id, { title });
                                        setThreadRenameKey(null);
                                      }}
                                      onCancel={() => setThreadRenameKey(null)}
                                    />
                                  ) : (
                                    <span className="thread-title">
                                      {renderThreadCliBadge(thread)}
                                      <span className="thread-title-text" title={thread.title}>{thread.title}</span>
                                    </span>
                                  )}
                                  {!epicProjectName && (
                                    <span className="thread-project-tag thread-meta">
                                      {projects.find((p) => p.id === thread.projectId)?.name}
                                    </span>
                                  )}
                                  <span className="thread-time thread-meta">
                                    {formatShortTime(getThreadActivityTime(thread))}
                                  </span>
                                </ThreadItemSelect>
                                <div
                                  className="thread-menu-wrap"
                                  ref={threadItemMenuKey === `epic:${thread.id}` ? threadItemMenuRef : undefined}
                                >
                                  <button
                                    type="button"
                                    className="thread-options-trigger"
                                    title="Thread options"
                                    aria-label={`Options for ${thread.title}`}
                                    aria-haspopup="menu"
                                    aria-expanded={threadItemMenuKey === `epic:${thread.id}`}
                                    onClick={() =>
                                      setThreadItemMenuKey((open) =>
                                        open === `epic:${thread.id}` ? null : `epic:${thread.id}`
                                      )
                                    }
                                  >
                                    <Ellipsis size={13} />
                                  </button>
                                  {threadItemMenuKey === `epic:${thread.id}` && (
                                    <div className="thread-menu thread-item-menu" role="menu">
                                      <button
                                        type="button"
                                        className="project-menu-item"
                                        role="menuitem"
                                        onClick={() => {
                                          setThreadItemMenuKey(null);
                                          setThreadRenameKey(`epic:${thread.id}`);
                                        }}
                                      >
                                        <SquarePen size={13} /> Rename
                                      </button>
                                      <button
                                        type="button"
                                        className="project-menu-item"
                                        role="menuitem"
                                        onClick={() => {
                                          setThreadItemMenuKey(null);
                                          branchThread(thread.id);
                                        }}
                                      >
                                        <GitBranch size={13} /> Branch
                                      </button>
                                      <button
                                        type="button"
                                        className="project-menu-item"
                                        role="menuitem"
                                        onClick={() => {
                                          setThreadItemMenuKey(null);
                                          handleRemoveThreadFromEpic(thread.id);
                                        }}
                                      >
                                        <EyeOff size={13} /> Remove from epic
                                      </button>
                                      <button
                                        type="button"
                                        className="project-menu-item danger"
                                        role="menuitem"
                                        onClick={() => {
                                          setThreadItemMenuKey(null);
                                          if (confirm('Delete this thread?')) {
                                            void deleteThreadWithRuntime(thread.id);
                                          }
                                        }}
                                      >
                                        <Trash2 size={13} /> Delete
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))
                            )}
                          </div>

                          {(hasMoreEpicThreads || isEpicListExpanded) && (
                            <button
                              type="button"
                              className="threads-show-more"
                              onClick={() =>
                                setThreadListLimits((prev) => {
                                  if (hasMoreEpicThreads) {
                                    return {
                                      ...prev,
                                      [epicThreadListKey]: epicThreads.length,
                                    };
                                  }
                                  const { [epicThreadListKey]: _removed, ...rest } = prev;
                                  return rest;
                                })
                              }
                            >
                              {hasMoreEpicThreads ? 'Show more' : 'Show less'}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {(projects.length > 0 || recentThreads.length > 0) && (
          <div className="recent-agents-section">
            <div className="recent-agents-header-row">
              <button
                type="button"
                className="sidebar-section-toggle"
                onClick={() =>
                  setRecentAgentsOpen((open) => {
                    // Collapsing resets the list back to the default 5 on next expand.
                    if (open) setRecentAgentsShowAll(false);
                    return !open;
                  })
                }
                aria-expanded={recentAgentsOpen}
              >
                <ChevronRight size={12} className={`sidebar-section-chevron ${recentAgentsOpen ? 'open' : ''}`} />
                <span>Recent agents</span>
              </button>
              {recentAgentsTargetProject && (
                <button
                  type="button"
                  className="project-new-thread"
                  title={`New thread in ${recentAgentsTargetProject.name}`}
                  aria-label={`New thread in ${recentAgentsTargetProject.name}`}
                  onClick={() => {
                    // The new thread lands at the top of this list, so
                    // make sure the list is showing.
                    setRecentAgentsOpen(true);
                    handleCreateThread(recentAgentsTargetProject.id);
                  }}
                >
                  <SquarePen size={13} />
                </button>
              )}
              {runningAgentCount > 0 && <span className="sidebar-section-count">{runningAgentCount}</span>}
            </div>
            {recentAgentsOpen && (
              <>
                <div className="threads-list recent-agents-list">
                  {recentThreads.length === 0 ? (
                    <div className="recent-agents-empty">No recent agents</div>
                  ) : (
                    (recentAgentsShowAll ? recentThreads : recentThreads.slice(0, THREADS_VISIBLE_LIMIT)).map(
                      (thread) => (
                        <div
                          key={thread.id}
                          className={threadItemClassName(thread.id)}
                          {...threadDragProps(thread.id, threadRenameKey === `recent:${thread.id}`)}
                        >
                          <ThreadItemSelect
                            isRenaming={threadRenameKey === `recent:${thread.id}`}
                            onActivate={() => selectThread(thread.id)}
                          >
                            {renderThreadStatusDot(thread)}
                            {threadRenameKey === `recent:${thread.id}` ? (
                              <InlineRenameInput
                                className="thread-rename-input"
                                initialValue={thread.title}
                                onSubmit={(title) => {
                                  updateThread(thread.id, { title });
                                  setThreadRenameKey(null);
                                }}
                                onCancel={() => setThreadRenameKey(null)}
                              />
                            ) : (
                              <span className="thread-title">
                                {renderThreadCliBadge(thread)}
                                <span className="thread-title-text" title={thread.title}>{thread.title}</span>
                              </span>
                            )}
                            <span className="thread-project-tag thread-meta">
                              {projects.find((p) => p.id === thread.projectId)?.name}
                            </span>
                            <span className="thread-time thread-meta">
                              {formatShortTime(getThreadActivityTime(thread))}
                            </span>
                          </ThreadItemSelect>
                          <div
                            className="thread-menu-wrap"
                            ref={threadItemMenuKey === `recent:${thread.id}` ? threadItemMenuRef : undefined}
                          >
                            <button
                              type="button"
                              className="thread-options-trigger"
                              title="Thread options"
                              aria-label={`Options for ${thread.title}`}
                              aria-haspopup="menu"
                              aria-expanded={threadItemMenuKey === `recent:${thread.id}`}
                              onClick={() =>
                                setThreadItemMenuKey((open) =>
                                  open === `recent:${thread.id}` ? null : `recent:${thread.id}`
                                )
                              }
                            >
                              <Ellipsis size={13} />
                            </button>
                            {threadItemMenuKey === `recent:${thread.id}` && (
                              <div className="thread-menu thread-item-menu" role="menu">
                                <button
                                  type="button"
                                  className="project-menu-item"
                                  role="menuitem"
                                  onClick={() => {
                                    setThreadItemMenuKey(null);
                                    setThreadRenameKey(`recent:${thread.id}`);
                                  }}
                                >
                                  <SquarePen size={13} /> Rename
                                </button>
                                <button
                                  type="button"
                                  className="project-menu-item"
                                  role="menuitem"
                                  onClick={() => {
                                    setThreadItemMenuKey(null);
                                    branchThread(thread.id);
                                  }}
                                >
                                  <GitBranch size={13} /> Branch
                                </button>
                                <button
                                  type="button"
                                  className="project-menu-item"
                                  role="menuitem"
                                  onClick={() => {
                                    setThreadItemMenuKey(null);
                                    pinThread(thread.id);
                                  }}
                                >
                                  <Pin size={13} /> Pin
                                </button>
                                {/* No project threads have no project list to fall back to. */}
                                {!isNoProjectId(thread.projectId) && (
                                  <button
                                    type="button"
                                    className="project-menu-item"
                                    role="menuitem"
                                    onClick={() => {
                                      setThreadItemMenuKey(null);
                                      updateThread(thread.id, {
                                        hiddenFromRecent: true,
                                      });
                                    }}
                                  >
                                    <EyeOff size={13} /> Remove from Recent
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="project-menu-item danger"
                                  role="menuitem"
                                  onClick={() => {
                                    setThreadItemMenuKey(null);
                                    if (confirm('Delete this thread?')) {
                                      void deleteThreadWithRuntime(thread.id);
                                    }
                                  }}
                                >
                                  <Trash2 size={13} /> Delete
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    )
                  )}
                </div>
                {recentThreads.length > THREADS_VISIBLE_LIMIT && (
                  <button
                    type="button"
                    className="threads-show-more"
                    onClick={() => setRecentAgentsShowAll((showAll) => !showAll)}
                  >
                    {recentAgentsShowAll ? 'Show less' : 'Show more'}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {projects.length === 0 && (
          <div className="empty-state p-8 text-center">
            <div className="empty-state-icon">
              <FolderOpen size={28} />
            </div>
            <div className="empty-state-title">No projects yet</div>
            <div className="text-xs text-[#6b6b74]">Add a folder to work on its code, or start a New agent to just chat</div>
            <button onClick={() => void handleAddProject()} className="btn mt-3">
              <Plus size={14} /> Add Project
            </button>
          </div>
        )}

        {projects.length > 0 && (
          <div className="sidebar-section-header">
            <span className="sidebar-section-title">Projects</span>
            <button
              type="button"
              className="sidebar-section-action"
              title="Add project"
              onClick={() => void handleAddProject()}
            >
              <FolderPlus size={14} />
            </button>
          </div>
        )}

        {sortedProjects.map((project) => {
          const projectThreads = projectThreadsByProject.get(project.id) ?? [];
          const isActiveProject = selectedProject?.id === project.id;
          // Highlighted like a selected epic: only while the project itself,
          // not one of its threads or an epic, is what the main view shows.
          const isProjectSelected = isActiveProject && !selectedThreadId && !selectedEpicId;
          const isCollapsed = collapsedProjects[project.id] ?? false;
          const visibleLimit = threadListLimits[project.id] ?? THREADS_VISIBLE_LIMIT;
          const visibleThreads = projectThreads.slice(0, visibleLimit);
          const hasMoreThreads = projectThreads.length > visibleLimit;
          const isListExpanded = visibleLimit > THREADS_VISIBLE_LIMIT && projectThreads.length > THREADS_VISIBLE_LIMIT;

          return (
            <div
              key={project.id}
              className={`project-section ${isActiveProject ? 'project-section-active' : ''}`}
              data-sidebar-reveal={`project:${project.id}`}
            >
              <div className="project-section-header-row">
                <button
                  type="button"
                  className="project-collapse-toggle"
                  title={isCollapsed ? 'Expand threads' : 'Collapse threads'}
                  aria-expanded={!isCollapsed}
                  onClick={() => {
                    // Collapsing resets the list back to the default 5 on next expand.
                    if (!isCollapsed) {
                      setThreadListLimits((prev) => {
                        if (!(project.id in prev)) return prev;
                        const { [project.id]: _removed, ...rest } = prev;
                        return rest;
                      });
                    }
                    setCollapsedProjects((prev) => ({
                      ...prev,
                      [project.id]: !isCollapsed,
                    }));
                  }}
                >
                  <ChevronRight size={12} className={`sidebar-section-chevron ${isCollapsed ? '' : 'open'}`} />
                </button>
                {projectRenameId === project.id ? (
                  <div className="project-section-header project-section-header-renaming">
                    <ProjectIcon projectPath={project.path} size={13} />
                    <InlineRenameInput
                      className="thread-rename-input"
                      initialValue={project.name}
                      onSubmit={(name) => {
                        renameProject(project.id, name);
                        setProjectRenameId(null);
                      }}
                      onCancel={() => setProjectRenameId(null)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`project-section-header ${isProjectSelected ? 'project-section-header-selected' : ''}`}
                    onClick={() => selectProject(project.id)}
                    title={project.path}
                  >
                    <ProjectIcon projectPath={project.path} size={13} />
                    <span className="truncate">{project.name}</span>
                    {isCollapsed && projectThreads.length > 0 && (
                      <span className="sidebar-section-count">{projectThreads.length}</span>
                    )}
                  </button>
                )}
                <div className="project-menu-wrap" ref={projectMenuOpenId === project.id ? projectMenuRef : undefined}>
                  <button
                    type="button"
                    className="project-options-trigger"
                    title="Project options"
                    aria-label={`Options for ${project.name}`}
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpenId === project.id}
                    onClick={() => setProjectMenuOpenId((open) => (open === project.id ? null : project.id))}
                  >
                    <Ellipsis size={13} />
                  </button>
                  {projectMenuOpenId === project.id && (
                    <div className="thread-menu project-menu" role="menu">
                      <button
                        type="button"
                        className="project-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setProjectMenuOpenId(null);
                          setProjectRenameId(project.id);
                        }}
                      >
                        <SquarePen size={13} /> Rename
                      </button>
                      <button
                        type="button"
                        className="project-menu-item danger"
                        role="menuitem"
                        onClick={() => {
                          setProjectMenuOpenId(null);
                          if (confirm(`Remove "${project.name}" and its threads? Files on disk are not affected.`)) {
                            void removeProjectWithRuntimes(project.id);
                          }
                        }}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="project-new-thread"
                  title={`New thread in ${project.name}`}
                  onClick={() => handleCreateThread(project.id)}
                >
                  <SquarePen size={13} />
                </button>
              </div>

              {!isCollapsed && (
                <>
                  <div className="threads-list">
                    {projectThreads.length === 0 ? (
                      <button
                        type="button"
                        className="thread-item thread-item-empty"
                        onClick={() => handleCreateThread(project.id)}
                      >
                        <span className="thread-title">New thread</span>
                      </button>
                    ) : (
                      visibleThreads.map((thread) => (
                        <div
                          key={thread.id}
                          className={threadItemClassName(thread.id)}
                          {...threadDragProps(thread.id, threadRenameKey === `project:${thread.id}`)}
                        >
                          <ThreadItemSelect
                            isRenaming={threadRenameKey === `project:${thread.id}`}
                            onActivate={() => selectThread(thread.id)}
                          >
                            {renderThreadStatusDot(thread)}
                            {threadRenameKey === `project:${thread.id}` ? (
                              <InlineRenameInput
                                className="thread-rename-input"
                                initialValue={thread.title}
                                onSubmit={(title) => {
                                  updateThread(thread.id, { title });
                                  setThreadRenameKey(null);
                                }}
                                onCancel={() => setThreadRenameKey(null)}
                              />
                            ) : (
                              <span className="thread-title">
                                {renderThreadCliBadge(thread)}
                                <span className="thread-title-text" title={thread.title}>{thread.title}</span>
                              </span>
                            )}
                            <span className="thread-time thread-meta">
                              {formatShortTime(getThreadActivityTime(thread))}
                            </span>
                          </ThreadItemSelect>
                          <div
                            className="thread-menu-wrap"
                            ref={threadItemMenuKey === `project:${thread.id}` ? threadItemMenuRef : undefined}
                          >
                            <button
                              type="button"
                              className="thread-options-trigger"
                              title="Thread options"
                              aria-label={`Options for ${thread.title}`}
                              aria-haspopup="menu"
                              aria-expanded={threadItemMenuKey === `project:${thread.id}`}
                              onClick={() =>
                                setThreadItemMenuKey((open) =>
                                  open === `project:${thread.id}` ? null : `project:${thread.id}`
                                )
                              }
                            >
                              <Ellipsis size={13} />
                            </button>
                            {threadItemMenuKey === `project:${thread.id}` && (
                              <div className="thread-menu thread-item-menu" role="menu">
                                <button
                                  type="button"
                                  className="project-menu-item"
                                  role="menuitem"
                                  onClick={() => {
                                    setThreadItemMenuKey(null);
                                    setThreadRenameKey(`project:${thread.id}`);
                                  }}
                                >
                                  <SquarePen size={13} /> Rename
                                </button>
                                <button
                                  type="button"
                                  className="project-menu-item"
                                  role="menuitem"
                                  onClick={() => {
                                    setThreadItemMenuKey(null);
                                    branchThread(thread.id);
                                  }}
                                >
                                  <GitBranch size={13} /> Branch
                                </button>
                                <button
                                  type="button"
                                  className="project-menu-item"
                                  role="menuitem"
                                  onClick={() => {
                                    setThreadItemMenuKey(null);
                                    if (thread.pinnedAt) unpinThread(thread.id);
                                    else pinThread(thread.id);
                                  }}
                                >
                                  {thread.pinnedAt ? (
                                    <>
                                      <PinOff size={13} /> Unpin
                                    </>
                                  ) : (
                                    <>
                                      <Pin size={13} /> Pin
                                    </>
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="project-menu-item danger"
                                  role="menuitem"
                                  onClick={() => {
                                    setThreadItemMenuKey(null);
                                    if (confirm('Delete this thread?')) {
                                      void deleteThreadWithRuntime(thread.id);
                                    }
                                  }}
                                >
                                  <Trash2 size={13} /> Delete
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {(hasMoreThreads || isListExpanded) && (
                    <button
                      type="button"
                      className="threads-show-more"
                      onClick={() =>
                        setThreadListLimits((prev) => {
                          if (hasMoreThreads) {
                            return {
                              ...prev,
                              [project.id]: projectThreads.length,
                            };
                          }
                          const { [project.id]: _removed, ...rest } = prev;
                          return rest;
                        })
                      }
                    >
                      {hasMoreThreads ? 'Show more' : 'Show less'}
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <SidebarFooter {...sidebarFooterProps} />
      {sidebarResizeHandle}
    </div>
  );
});
