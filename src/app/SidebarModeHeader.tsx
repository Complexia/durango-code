import React, { useLayoutEffect, useRef } from 'react';
import { Bot, Folder, MessagesSquare } from 'lucide-react';
import { SIDEBAR_TABS, useOrionStore, type SidebarTab } from '../store';
import { useBotsTabBadge } from './botsTabBadge';
import { SidebarFooter, type SidebarFooterProps } from './SidebarFooter';
import { useSidebarResize } from './useSidebarResize';

// The top of the Agents sidebar on both tabs: the Projects entry (it opens
// the projects window, a page of the Bots tab) and the Threads | Bots switch.
// The Threads sidebar (SidebarV2.tsx) and the Bots sidebar (BotsWorkspace.tsx)
// both render it first, so it stays put when the tab changes.

/** Both tabs' sidebars share one width, so switching never moves the main view. */
export const AGENTS_SIDEBAR_STORAGE_KEY = 'orion.agentsSidebarWidth';

/** The Bots view's code, loaded the first time it shows (App's React.lazy) or ahead of a click on its tab. */
export const loadBotsWorkspace = () => import('./BotsWorkspace');

// A keyboard switch remounts the sidebar (each tab has its own), so the tab
// to focus is handed to the header that mounts next.
let focusTabOnMount: SidebarTab | null = null;

const TABS: Record<SidebarTab, { label: string; Icon: typeof Bot }> = {
  threads: { label: 'Threads', Icon: MessagesSquare },
  bots: { label: 'Bots', Icon: Bot },
};

/** `transient`: the copy shown while the Bots view loads; it takes focus but leaves the handoff for the real one. */
export const SidebarModeHeader = React.memo(function SidebarModeHeader({ transient = false }: { transient?: boolean }) {
  const tab = useOrionStore((state) => state.sidebarTab);
  const setSidebarTab = useOrionStore((state) => state.setSidebarTab);
  const projectCount = useOrionStore((state) => state.projects.length);
  const botsView = useOrionStore((state) => state.sidebarV3Settings?.view ?? 'bot');
  // Only a profile that has opened Bots (it picks a bot on first open) polls for the badge.
  const usesBots = useOrionStore((state) => Boolean(state.sidebarV3Settings?.selectedBotId));
  const setSidebarV3Settings = useOrionStore((state) => state.setSidebarV3Settings);
  const badge = useBotsTabBadge(tab === 'threads' && usesBots);
  const tabRefs = useRef<Partial<Record<SidebarTab, HTMLButtonElement | null>>>({});
  useLayoutEffect(() => {
    if (!focusTabOnMount || focusTabOnMount !== tab) return;
    if (!transient) focusTabOnMount = null;
    tabRefs.current[tab]?.focus();
  }, [tab, transient]);

  const projectsActive = tab === 'bots' && (botsView === 'projects' || botsView === 'project');
  const openProjects = () => {
    setSidebarV3Settings({ view: 'projects' });
    setSidebarTab('bots');
  };
  const select = (next: SidebarTab, focus = false) => {
    if (next === tab) {
      if (focus) tabRefs.current[next]?.focus();
      return;
    }
    if (focus) focusTabOnMount = next;
    setSidebarTab(next);
  };
  // A tablist: arrow keys (and Home / End) move between the tabs and open them.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = SIDEBAR_TABS.indexOf(tab);
    const target =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? SIDEBAR_TABS[(index + 1) % SIDEBAR_TABS.length]
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? SIDEBAR_TABS[(index - 1 + SIDEBAR_TABS.length) % SIDEBAR_TABS.length]
          : event.key === 'Home'
            ? SIDEBAR_TABS[0]
            : event.key === 'End'
              ? SIDEBAR_TABS[SIDEBAR_TABS.length - 1]
              : null;
    if (!target) return;
    event.preventDefault();
    select(target, true);
  };

  const showBadge = tab !== 'bots' && (badge.unread > 0 || badge.working || badge.needsYou);
  const badgeLabel =
    badge.unread > 0
      ? `${badge.unread} unread`
      : badge.needsYou
        ? 'a bot needs you'
        : badge.working
          ? 'a bot is working'
          : '';

  return (
    <div className="sidebar-mode-header">
      <button
        type="button"
        className={`sidebar-projects-row ${projectsActive ? 'active' : ''}`}
        onClick={openProjects}
        aria-current={projectsActive ? 'page' : undefined}
      >
        <Folder size={16} className="sidebar-projects-row-icon" aria-hidden />
        <span className="sidebar-projects-row-label">Projects</span>
        {projectCount > 0 && <span className="sidebar-projects-row-count">{projectCount}</span>}
      </button>
      {/* Focus anywhere in the switch starts loading the Bots view, so an arrow key rarely waits on it. */}
      <div className="sidebar-mode-tabs" role="tablist" aria-label="Sidebar" onKeyDown={onKeyDown} onFocus={() => void loadBotsWorkspace()}>
        {SIDEBAR_TABS.map((id) => {
          const { label, Icon } = TABS[id];
          const selected = tab === id;
          return (
            <button
              key={id}
              ref={(element) => {
                tabRefs.current[id] = element;
              }}
              type="button"
              role="tab"
              id={`sidebar-tab-${id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              aria-label={id === 'bots' && showBadge ? `${label}, ${badgeLabel}` : undefined}
              className={`sidebar-mode-tab ${selected ? 'active' : ''}`}
              onClick={() => select(id)}
              onPointerEnter={id === 'bots' ? () => void loadBotsWorkspace() : undefined}
            >
              <Icon size={14} aria-hidden />
              <span>{label}</span>
              {id === 'bots' && showBadge && (
                <span className="sidebar-mode-tab-badge-slot" aria-hidden>
                  {badge.unread > 0 ? (
                    <span className="sidebar-mode-tab-count">{badge.unread > 99 ? '99+' : badge.unread}</span>
                  ) : (
                    <span className={`sidebar-mode-tab-dot ${badge.needsYou ? 'needs-you' : 'working animate-pulse'}`} />
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});

/**
 * The Bots tab while its code loads (the first open, if the pointer never
 * reached its tab first): the same sidebar frame and header, so nothing moves.
 */
export const BotsTabLoading: React.FC<{ sidebarFooterProps: SidebarFooterProps }> = ({ sidebarFooterProps }) => {
  const { sidebarRef, resizeHandle } = useSidebarResize({ storageKey: AGENTS_SIDEBAR_STORAGE_KEY, label: 'Agents sidebar' });
  return (
    <>
      <div className="sidebar agents-sidebar" ref={sidebarRef}>
        <SidebarModeHeader transient />
        <div className="sidebar-content agents-sidebar-content" />
        <SidebarFooter {...sidebarFooterProps} />
        {resizeHandle}
      </div>
      <div className="panel agents-panel" />
    </>
  );
};
