import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CornerLeftUp,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquareDashed,
  Search,
  Trash2,
} from 'lucide-react';
import { NO_PROJECT_ID, type Project } from '../store';
import { ProjectBadge } from './ProjectBadge';
import { normalizeSearchText, parseSearchQuery } from './threadSearch';

// The project picker as a command-palette modal, after T3 Code's "New thread
// in…" palette (MIT, T3 Tools Inc.). The projects view lists every project
// with its path, "No project" and "Add project"; ⌘1–⌘9 pick the first nine
// projects and ⌥⌘N picks No project while it is open. The add view browses
// the disk from the search field itself: type or Tab through folders, Enter
// opens one, ⌘Enter (or the Add button) adds the folder as a project, and
// "Open in Finder" falls back to the system folder dialog.

const EXIT_MS = 140;

export type ProjectPickerView = 'projects' | 'add-project';

type BrowseListing = {
  /** The path as asked for (may start with ~), to match a reply to its query. */
  requestedPath: string;
  homeDir: string;
  /** The listed directory, absolute, with a trailing separator. */
  directoryPath: string;
  parentPath: string | null;
  exists: boolean;
  entries: Array<{ name: string; fullPath: string }>;
};

type ProjectRow =
  | { kind: 'project'; project: Project; shortcut: string | null }
  | { kind: 'no-project'; shortcut: string }
  | { kind: 'add-project' };

type BrowseRow = { kind: 'up'; path: string } | { kind: 'directory'; name: string; fullPath: string };

const isBrowseQuery = (value: string) => value.startsWith('/') || value.startsWith('~/') || value === '~';

const hasTrailingSeparator = (value: string) => value.endsWith('/');
const browseDirectoryPart = (value: string) =>
  hasTrailingSeparator(value) ? value : value.slice(0, value.lastIndexOf('/') + 1);
const browseLeafPart = (value: string) => (hasTrailingSeparator(value) ? '' : value.slice(value.lastIndexOf('/') + 1));

const tildify = (absolute: string, homeDir: string | null) =>
  homeDir && (absolute === homeDir || absolute.startsWith(`${homeDir}/`)) ? `~${absolute.slice(homeDir.length)}` : absolute;

/** Where browsing starts: the folder holding the most recent project, else home. */
const initialBrowseQuery = (projects: Project[], homeDir: string | null) => {
  const recent = projects[0]?.path;
  if (!recent) return '~/';
  const parent = recent.slice(0, recent.lastIndexOf('/') + 1);
  if (!parent || parent === '/') return '~/';
  return tildify(parent, homeDir);
};

let homeDirCache: string | null = null;

export type ProjectPickerModalProps = {
  open: boolean;
  /** Which view to open on. "add-project" goes straight to the folder browser. */
  initialView?: ProjectPickerView;
  /** Most relevant first; the order sets the ⌘1–⌘9 shortcuts. */
  projects: Project[];
  selectedProjectId: string | null;
  /** Hide "No project" and the project shortcuts when only adding a project. */
  onSelect?: (projectId: string) => void;
  /** Adds the folder at `path` as a project (creating the folder when asked). */
  onAddProjectPath: (path: string) => void;
  /** The system folder dialog. */
  onAddProjectWithDialog: () => void;
  /** Offers a remove button on each project row (asks before removing). */
  onRemoveProject?: (project: Project) => void;
  onClose: () => void;
};

export const ProjectPickerModal: React.FC<ProjectPickerModalProps> = ({
  open,
  initialView = 'projects',
  projects,
  selectedProjectId,
  onSelect,
  onAddProjectPath,
  onAddProjectWithDialog,
  onRemoveProject,
  onClose,
}) => {
  // Stay mounted through the exit animation after `open` turns false.
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const [view, setView] = useState<ProjectPickerView>(initialView);
  // The projects view's query is kept while browsing so Back restores it.
  const [projectQuery, setProjectQuery] = useState('');
  const [browseQuery, setBrowseQuery] = useState('~/');
  const [activeIndex, setActiveIndex] = useState(0);
  const [listing, setListing] = useState<BrowseListing | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Hover only moves the highlight once the pointer really moves, so a list
  // that scrolls or re-renders under a resting cursor keeps the keyboard's row.
  const pointerMovedRef = useRef(false);
  const projectsOnly = !onSelect;
  const browsing = view === 'add-project';
  const query = browsing ? browseQuery : projectQuery;

  const startBrowsing = useCallback(
    (fromQuery?: string) => {
      setView('add-project');
      setBrowseQuery(fromQuery ?? initialBrowseQuery(projects, homeDirCache));
      setAddError(null);
    },
    [projects]
  );

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      setProjectQuery('');
      setAddError(null);
      pointerMovedRef.current = false;
      if (initialView === 'add-project' || projectsOnly) startBrowsing();
      else setView('projects');
      return undefined;
    }
    if (!mounted) return undefined;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
    // Only reacts to opening and closing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ---- Projects view -------------------------------------------------------

  const projectRows = useMemo<ProjectRow[]>(() => {
    const { tokens } = parseSearchQuery(projectQuery);
    const matches = (text: string) => {
      const normalized = normalizeSearchText(text);
      return tokens.every((token) => normalized.includes(token));
    };
    const rows: ProjectRow[] = projects.map((project, index) => ({
      kind: 'project',
      project,
      shortcut: index < 9 ? `⌘${index + 1}` : null,
    }));
    // Like T3: No project sits right after the first project.
    rows.splice(Math.min(1, rows.length), 0, { kind: 'no-project', shortcut: '⌥⌘N' });
    rows.push({ kind: 'add-project' });
    if (tokens.length === 0) return rows;
    return rows.filter((row) => {
      if (row.kind === 'project') return matches(`${row.project.name} ${row.project.path}`);
      if (row.kind === 'no-project') return matches('no project without none chat');
      return matches('add project new folder open');
    });
  }, [projectQuery, projects]);

  // ---- Add-project view ----------------------------------------------------

  const directoryPart = browsing ? browseDirectoryPart(browseQuery) : '';
  const leaf = browsing ? browseLeafPart(browseQuery) : '';

  useEffect(() => {
    if (!mounted || !browsing || !directoryPart) return undefined;
    let cancelled = false;
    const browse = window.orion?.browseDirectories;
    if (!browse) return undefined;
    void browse(directoryPart)
      .then((result) => {
        if (cancelled || !result) return;
        homeDirCache = result.homeDir;
        setListing(result);
      })
      .catch(() => {
        if (!cancelled) setListing(null);
      });
    return () => {
      cancelled = true;
    };
  }, [browsing, directoryPart, mounted]);

  // The listing can lag the query by one directory while the IPC is in flight.
  const listingCurrent = !!listing && listing.requestedPath === directoryPart;

  const browseRows = useMemo<BrowseRow[]>(() => {
    if (!browsing || !listing || !listingCurrent) return [];
    const lowerLeaf = leaf.toLowerCase();
    const showHidden = leaf.startsWith('.');
    const directories = listing.entries
      .filter(
        (entry) => entry.name.toLowerCase().startsWith(lowerLeaf) && (showHidden || !entry.name.startsWith('.'))
      )
      .map<BrowseRow>((entry) => ({ kind: 'directory', name: entry.name, fullPath: entry.fullPath }));
    return !leaf && listing.parentPath ? [{ kind: 'up', path: listing.parentPath }, ...directories] : directories;
  }, [browsing, leaf, listing, listingCurrent]);

  const exactEntry =
    browsing && leaf && listingCurrent
      ? (listing?.entries.find((entry) => entry.name === leaf) ?? null)
      : null;
  const projectPaths = useMemo(() => new Set(projects.map((project) => project.path)), [projects]);
  // The folder "Add" would add right now.
  const addTarget = !browsing
    ? null
    : hasTrailingSeparator(browseQuery)
      ? listingCurrent && listing?.exists
        ? listing.directoryPath.replace(/\/$/, '') || '/'
        : browseQuery.replace(/\/$/, '')
      : (exactEntry?.fullPath ?? browseQuery);
  const addTargetMissing =
    browsing && !hasTrailingSeparator(browseQuery) && listingCurrent && !exactEntry && leaf.length > 0;
  const addTargetIsProject =
    !!addTarget && listingCurrent && (projectPaths.has(addTarget) || projectPaths.has(exactEntry?.fullPath ?? ''));

  // ---- Shared --------------------------------------------------------------

  const rowCount = browsing ? browseRows.length : projectRows.length;

  // Open on the current project so Enter alone keeps it; reset per query.
  useLayoutEffect(() => {
    if (!open) return;
    if (browsing) {
      setActiveIndex(0);
      return;
    }
    const current = projectRows.findIndex(
      (row) =>
        (row.kind === 'project' && row.project.id === selectedProjectId) ||
        (row.kind === 'no-project' && selectedProjectId === NO_PROJECT_ID)
    );
    setActiveIndex(projectQuery ? 0 : Math.max(0, current));
    // Not on every row change: arrowing must not be reset by a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, projectQuery, browseQuery]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, view]);

  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-picker-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, view]);

  const selectProject = (projectId: string) => {
    onSelect?.(projectId);
    onClose();
  };

  const addProject = (path: string | null) => {
    if (!path) return;
    if (projectPaths.has(path)) {
      const existing = projects.find((project) => project.path === path);
      if (existing && onSelect) {
        selectProject(existing.id);
        return;
      }
      setAddError('That folder is already a project');
      return;
    }
    onClose();
    onAddProjectPath(path);
  };

  const enterDirectory = (row: BrowseRow) => {
    if (row.kind === 'up') {
      setBrowseQuery(tildify(row.path.endsWith('/') ? row.path : `${row.path}/`, listing?.homeDir ?? null));
      return;
    }
    setBrowseQuery(`${directoryPart}${row.name}/`);
  };

  const chooseProjectRow = (row: ProjectRow | undefined) => {
    if (!row) return;
    if (row.kind === 'add-project') startBrowsing();
    else selectProject(row.kind === 'project' ? row.project.id : NO_PROJECT_ID);
  };

  const goBack = () => {
    if (projectsOnly) {
      onClose();
      return;
    }
    setView('projects');
    setAddError(null);
  };

  const moveHighlight = (delta: number) => {
    if (!rowCount) return;
    pointerMovedRef.current = false;
    setActiveIndex((index) => (index + delta + rowCount) % rowCount);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!browsing && onSelect) {
      if (mod && event.altKey && event.code === 'KeyN') {
        event.preventDefault();
        selectProject(NO_PROJECT_ID);
        return;
      }
      if (mod && !event.altKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const project = projects[Number(event.key) - 1];
        if (project) selectProject(project.id);
        return;
      }
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveHighlight(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveHighlight(-1);
        return;
      case 'Tab':
        if (browsing) {
          event.preventDefault();
          const row = browseRows[activeIndex];
          if (row) enterDirectory(row);
        }
        return;
      case 'Enter': {
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (!browsing) {
          chooseProjectRow(projectRows[activeIndex]);
          return;
        }
        const row = browseRows[activeIndex];
        if (mod) {
          addProject(row?.kind === 'directory' ? row.fullPath : addTarget);
          return;
        }
        if (row) enterDirectory(row);
        else addProject(addTarget);
        return;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      case 'Backspace':
        if (!query) {
          event.preventDefault();
          if (browsing) goBack();
          else onClose();
        }
        return;
      default:
    }
  };

  const onQueryChange = (value: string) => {
    setAddError(null);
    if (browsing) {
      setBrowseQuery(value);
      return;
    }
    // Typing a path in the projects view switches to browsing it (as in T3).
    if (isBrowseQuery(value)) startBrowsing(value === '~' ? '~/' : value);
    else setProjectQuery(value);
  };

  if (!mounted) return null;

  const rowClass = (active: boolean) =>
    `flex w-full items-center gap-3 rounded-lg px-3 py-[7px] text-left outline-none ${
      active ? 'bg-white/[0.08]' : 'bg-transparent'
    }`;
  const rowPointerProps = (index: number) => ({
    'data-picker-index': index,
    onMouseMove: () => {
      pointerMovedRef.current = true;
      setActiveIndex(index);
    },
    onMouseEnter: () => {
      if (pointerMovedRef.current) setActiveIndex(index);
    },
    // Keep focus (and the caret) in the search field.
    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
  });

  const renderProjectRow = (row: ProjectRow, index: number) => {
    const active = index === activeIndex;
    const current =
      (row.kind === 'project' && row.project.id === selectedProjectId) ||
      (row.kind === 'no-project' && selectedProjectId === NO_PROJECT_ID);
    const key = row.kind === 'project' ? row.project.id : row.kind;
    return (
      <div
        key={key}
        role="option"
        aria-selected={active}
        className={`group cursor-pointer ${rowClass(active)}`}
        onClick={() => chooseProjectRow(row)}
        {...rowPointerProps(index)}
      >
        <span className="flex h-5 shrink-0 items-center self-start pt-px">
          {row.kind === 'project' ? (
            <ProjectBadge project={row.project} size={16} />
          ) : row.kind === 'no-project' ? (
            <MessageSquareDashed size={16} className="text-neutral-400" aria-hidden />
          ) : (
            <FolderPlus size={16} className="text-neutral-400" aria-hidden />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2 text-[13.5px] text-neutral-100">
            <span className="truncate">
              {row.kind === 'project' ? row.project.name : row.kind === 'no-project' ? 'No project' : 'Add project…'}
            </span>
            {current && (
              <span className="shrink-0 rounded-[5px] bg-white/[0.07] px-1.5 py-px text-[10.5px] font-medium text-neutral-400">
                Current
              </span>
            )}
          </span>
          {row.kind === 'project' && (
            <span className="flex min-w-0 items-center gap-1 text-[12px] text-neutral-500">
              <span className="shrink-0">Local</span>
              <span className="shrink-0 text-neutral-600">·</span>
              <span className="truncate">{row.project.path}</span>
            </span>
          )}
          {row.kind === 'add-project' && (
            <span className="truncate text-[12px] text-neutral-500">Browse to a folder on this Mac</span>
          )}
        </span>
        {row.kind === 'project' && onRemoveProject && (
          <button
            type="button"
            title={`Remove ${row.project.name}`}
            aria-label={`Remove ${row.project.name}`}
            className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-red-500/10 hover:text-red-300 group-hover:inline-flex"
            onClick={(event) => {
              event.stopPropagation();
              onRemoveProject(row.project);
            }}
          >
            <Trash2 size={13} />
          </button>
        )}
        {row.kind !== 'add-project' && row.shortcut && (
          <kbd className="ms-auto shrink-0 font-sans text-[12px] font-medium tracking-widest text-neutral-500">
            {row.shortcut}
          </kbd>
        )}
      </div>
    );
  };

  const renderBrowseRow = (row: BrowseRow, index: number) => {
    const active = index === activeIndex;
    const added = row.kind === 'directory' && projectPaths.has(row.fullPath);
    return (
      <button
        key={row.kind === 'up' ? '..' : row.fullPath}
        type="button"
        role="option"
        aria-selected={active}
        className={rowClass(active)}
        onClick={() => enterDirectory(row)}
        {...rowPointerProps(index)}
      >
        {row.kind === 'up' ? (
          <CornerLeftUp size={15} className="shrink-0 text-neutral-500" aria-hidden />
        ) : (
          <Folder size={15} className="shrink-0 text-neutral-500" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-neutral-100">
          {row.kind === 'up' ? '..' : row.name}
        </span>
        {added && <span className="shrink-0 text-[11.5px] text-neutral-500">Added</span>}
        {active && row.kind === 'directory' && (
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-neutral-500">
            <Kbd>⌘</Kbd>
            <Kbd>⏎</Kbd>
            to add
          </span>
        )}
      </button>
    );
  };

  const emptyBrowseMessage = !listingCurrent
    ? null
    : !listing?.exists
      ? 'That folder doesn’t exist yet — press Enter to create it and add it as a project.'
      : addTargetMissing
        ? 'No folder by that name — press Enter to create it and add it as a project.'
        : 'No folders here — press Enter to add this one.';

  return createPortal(
    <div
      className={`fixed inset-0 z-[1100] flex justify-center px-4 pt-[max(16px,10vh)] ${
        closing ? 'picker-backdrop-out' : 'picker-backdrop-in'
      } bg-[rgb(10_10_12_/_0.62)] backdrop-blur-[4px]`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={browsing ? 'Add a project' : 'Choose a project'}
        className={`flex h-fit max-h-[min(420px,80vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[rgb(20_20_23_/_0.86)] text-neutral-200 shadow-[inset_0_1px_rgb(255_255_255_/_0.04),0_24px_72px_-20px_rgb(0_0_0_/_0.9)] backdrop-blur-xl backdrop-saturate-[1.14] ${
          closing ? 'picker-panel-out' : 'picker-panel-in'
        }`}
        onKeyDown={handleKeyDown}
      >
        <div className="relative flex items-center gap-2.5 px-4 py-2.5">
          {browsing ? (
            <button
              type="button"
              aria-label="Back"
              title="Back"
              className="-ml-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-white/[0.07] hover:text-neutral-100"
              onClick={goBack}
            >
              {projectsOnly ? <FolderPlus size={16} /> : <ArrowLeft size={16} />}
            </button>
          ) : (
            <Search size={16} className="shrink-0 text-neutral-500" aria-hidden />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={browsing ? 'Enter path (e.g. ~/projects/my-app)' : 'Search…'}
            className={`h-9 min-w-0 flex-1 bg-transparent text-[14.5px] text-neutral-100 outline-none placeholder:text-neutral-500 ${
              browsing ? 'pr-20 font-mono text-[13.5px]' : ''
            }`}
            role="combobox"
            aria-expanded="true"
            aria-controls="project-picker-list"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          {browsing && (
            <button
              type="button"
              className="absolute right-3 top-1/2 inline-flex h-7 -translate-y-1/2 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[12px] font-medium text-neutral-200 transition-colors hover:bg-white/[0.09] disabled:opacity-40"
              disabled={!addTarget}
              title={addTarget ? `Add ${addTarget}` : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addProject(addTarget)}
            >
              Add <Kbd>⏎</Kbd>
            </button>
          )}
        </div>
        <div className="h-px bg-white/[0.06]" />
        <div
          ref={listRef}
          id="project-picker-list"
          role="listbox"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
          onMouseLeave={() => {
            pointerMovedRef.current = false;
          }}
        >
          {browsing ? (
            <>
              <div className="flex items-center justify-between px-3 py-1.5 text-[12px] font-medium text-neutral-500">
                <span>Directories</span>
                {addTargetIsProject && <span className="font-normal">Already a project</span>}
              </div>
              {browseRows.map(renderBrowseRow)}
              {browseRows.length === 0 && emptyBrowseMessage && (
                <div className="px-3 py-4 text-[12.5px] text-neutral-500">{emptyBrowseMessage}</div>
              )}
            </>
          ) : (
            <>
              {projectRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-[13px] text-neutral-500">
                  Nothing matches “{projectQuery}”
                </div>
              ) : (
                <div className="px-3 py-1.5 text-[12px] font-medium text-neutral-500">Projects</div>
              )}
              {projectRows.map(renderProjectRow)}
            </>
          )}
          {addError && <div className="px-3 pb-1 pt-2 text-[12.5px] text-amber-300">{addError}</div>}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-white/[0.07] bg-white/[0.025] px-4 py-2.5 text-[12.5px] font-medium text-neutral-500">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <Kbd>
                <ArrowUp size={12} />
              </Kbd>
              <Kbd>
                <ArrowDown size={12} />
              </Kbd>
              <span className="ml-0.5">Navigate</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd>
              <span className="ml-0.5">{browsing ? 'Open' : 'Select'}</span>
            </span>
            {browsing && (
              <span className="inline-flex items-center gap-1">
                <Kbd>Backspace</Kbd>
                <span className="ml-0.5">Back</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd>
              <span className="ml-0.5">Close</span>
            </span>
          </div>
          {browsing && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-100"
              onClick={() => {
                onClose();
                onAddProjectWithDialog();
              }}
            >
              <FolderOpen size={13} /> Open in Finder
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-white/[0.08] px-1 font-sans text-[11.5px] font-medium text-neutral-200">
    {children}
  </kbd>
);
