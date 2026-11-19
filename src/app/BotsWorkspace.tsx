import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowUp,
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  Clock,
  Copy,
  CornerDownLeft,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Library,
  ListChecks,
  Loader2,
  MessagesSquare,
  NotebookPen,
  Paperclip,
  Pause,
  Pin,
  Plus,
  Search,
  Trash2,
  Undo2,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import { defaultDurangoBotsSettings, defaultDurangoSettings, useOrionStore, type Thread } from '../store';
import { formatShortTime, getThreadActivityTime } from './time';
import { botFaceDataUrl, botFaceSeed } from './botFace';
import { ThreadRow, type SidebarV2Actions } from './SidebarV2';
import { compareSidebarV2Recent, sidebarV2ThreadLists, threadSidebarTone } from './threadLists';
import { MarkdownContent } from './markdown';
import { SidebarFooter, type SidebarFooterProps } from './SidebarFooter';
import { useSidebarResize } from './useSidebarResize';
import {
  botInboxSource,
  botIsWorking,
  LOCAL_BOT_PLACE,
  formatFileSize,
  newBotMessageId,
  projectBotFor,
  relativeBotTime,
  type BotProject,
  type BotProjectFile,
  type BotProjectNote,
  type BotProjectTarget,
  type DesktopBot,
  type DesktopBotMessage,
  type DesktopBotThread,
  type BotAttachmentFile,
} from './bots';

// Sidebar v3 (Settings → Experimental): the sidebar lists the person's Durango
// bots instead of threads, and the main panel is the picked bot's
// conversation. Messages are never blocked: they queue in the bot's thread and
// a reply in progress takes them in. Data comes from Durango with this app's
// sign-in (window.orion.listBots / getBotThread / sendBotMessage), polled
// while the view is open: briskly while a bot is replying, slowly otherwise.
// Signed out of Durango, the same calls reach this device's own bots
// (src/main/local-bots.js), whose replies run on this machine's Claude Code.

const LIST_POLL_MS = 5_000;
const THREAD_POLL_ACTIVE_MS = 1_200;
const THREAD_POLL_IDLE_MS = 4_000;
const SIDEBAR_STORAGE_KEY = 'orion.botsSidebarWidth';

type Outgoing = { id: string; content: string; files?: BotAttachmentFile[]; failed?: string };

// The last data the Bots view showed, kept while the app runs: switching to
// the Code tab unmounts the view, and coming back shows this at once while a
// fresh load runs in the background (instead of "Loading bots…").
type BotListCache = {
  /** Whose (BotsListResult.account). */
  account: string | null;
  bots: DesktopBot[];
  projectKeys: Record<string, string>;
  allowed: boolean;
  mode: 'local' | 'durango' | null;
  cloudOnly: boolean;
};
let botListCache: BotListCache | null = null;
const botThreadCache = new Map<string, DesktopBotThread>();
const botProjectCache = new Map<string, BotProject | null>();
// Bumped whenever the caches are dropped: a response to a request made
// before (for another account) is ignored.
let botCacheGeneration = 0;
const clearBotCaches = () => {
  botCacheGeneration += 1;
  botListCache = null;
  botThreadCache.clear();
  botProjectCache.clear();
};
const projectCacheKey = (target: BotProjectTarget) => target.botId ?? `project:${target.projectId}`;

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
const THIS_DEVICE = isMac ? 'this Mac' : 'this computer';

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

type FaceBot = Pick<DesktopBot, 'emoji' | 'name' | 'role'> & { id?: string; project?: { key: string } | null; faceSeed?: string };

/** A bot's emoji, or its robot face (botFace.ts) when it has none. */
const BotIcon: React.FC<{ bot: FaceBot; px: number }> = ({ bot, px }) => {
  if (bot.emoji) return <>{bot.emoji}</>;
  const seed = bot.faceSeed ?? (bot.id ? botFaceSeed({ id: bot.id, project: bot.project }) : bot.name);
  return <img src={botFaceDataUrl(seed)} width={px} height={px} alt="" draggable={false} className="block" />;
};

const BotAvatar: React.FC<{ bot: FaceBot; size?: 'sm' | 'md' }> = ({ bot, size = 'sm' }) => (
  <span
    className={`relative inline-flex shrink-0 items-center justify-center rounded-[10px] bg-white/[0.06] ring-1 ring-white/10 ${
      size === 'md' ? 'h-8 w-8 text-[16px]' : 'h-6 w-6 text-[13px]'
    }`}
    aria-hidden
  >
    <BotIcon bot={bot} px={size === 'md' ? 24 : 18} />
    {bot.role === 'primary' && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />}
  </span>
);

type WorkspaceProps = {
  sidebarFooterProps: SidebarFooterProps;
  /** The usual thread view (App's agents panel), shown when a thread is open here. */
  threadPanel: React.ReactNode;
  /** Starts a new thread in a project; returns its id. */
  onNewThread: (projectId: string) => string;
  /** Sidebar v2's thread actions and state: the project page lists threads with its rows. */
  threadActions: SidebarV2Actions;
  attentionThreadIds: ReadonlyMap<string, number>;
  paneThreadIds: string[];
};

/** A row of the projects window: a Durango Code project here, or a project bot's project elsewhere. */
type ProjectEntry = {
  /** Store project id, or `bot:<botId>`. */
  id: string;
  name: string;
  path: string | null;
  bot: DesktopBot | null;
  /** The project's key (its bot's icon is picked by it). */
  key: string | null;

  threads: Thread[];
};

export const BotsWorkspace = React.memo(function BotsWorkspace({
  sidebarFooterProps,
  threadPanel,
  onNewThread,
  threadActions,
  attentionThreadIds,
}: WorkspaceProps) {
  const v3 = useOrionStore((state) => state.sidebarV3Settings);
  const selectedBotId = v3?.selectedBotId ?? null;
  const view = v3?.view ?? 'bot';
  const selectedProjectId = v3?.selectedProjectId ?? null;
  const setSidebarV3Settings = useOrionStore((state) => state.setSidebarV3Settings);
  const projects = useOrionStore((state) => state.projects);
  const threads = useOrionStore((state) => state.threads);
  const { sidebarRef, resizeHandle } = useSidebarResize({ storageKey: SIDEBAR_STORAGE_KEY, label: 'Bots sidebar' });
  const [bots, setBots] = useState<DesktopBot[] | null>(() => botListCache?.bots ?? null);
  const [projectKeys, setProjectKeys] = useState<Record<string, string>>(() => botListCache?.projectKeys ?? {});
  const [listError, setListError] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(() => botListCache?.allowed ?? true);
  const [mode, setMode] = useState<'local' | 'durango' | null>(() => botListCache?.mode ?? null);
  // Signed in with Claude Code here, but bot replies on this machine are
  // turned off (Settings → Durango): they run in Durango's cloud instead.
  const [cloudOnly, setCloudOnly] = useState(() => botListCache?.cloudOnly ?? false);
  // Whose bots are shown: views below remount when it changes, so nothing of
  // another account stays on screen.
  const [account, setAccount] = useState<string | null>(() => botListCache?.account ?? null);
  const setDurangoSettings = useOrionStore((state) => state.setDurangoSettings);
  const answerHere = () => {
    const current = useOrionStore.getState().durangoSettings ?? defaultDurangoSettings;
    setDurangoSettings({ bots: { ...defaultDurangoBotsSettings, ...current.bots, enabled: true } });
    setCloudOnly(false);
  };

  const loadBots = useCallback(async () => {
    const [result, modeResult] = await Promise.all([window.orion?.listBots?.(), window.orion?.getBotsMode?.().catch(() => null)]);
    const nextMode = modeResult ? modeResult.mode : botListCache?.mode ?? null;
    const nextCloudOnly = modeResult
      ? modeResult.mode === 'durango' && modeResult.claudeAvailable && modeResult.machineReplies === false
      : botListCache?.cloudOnly ?? false;
    if (modeResult) {
      setMode(nextMode);
      setCloudOnly(nextCloudOnly);
    }
    if (!result) return;
    if (!result.ok) {
      if (result.code === 'account_changed') return;
      // Signed out: nothing cached may show.
      if (result.code === 'not_signed_in') {
        clearBotCaches();
        setBots(null);
        setAccount(null);
      }
      setListError(result.code === 'not_signed_in' ? 'Sign in to Durango (Settings → Durango) to see your bots.' : result.error ?? 'Couldn’t load your bots.');
      return;
    }
    // Another account (or signed in or out) since the cache was made: the old
    // account's bots, threads and libraries go.
    const nextAccount = result.account ?? null;
    if (botListCache && (botListCache.mode !== nextMode || botListCache.account !== nextAccount)) clearBotCaches();
    setAccount(nextAccount);
    setListError(null);
    setAllowed(result.allowed !== false);
    setBots(result.bots ?? []);
    setProjectKeys(result.projectKeys ?? {});
    botListCache = {
      account: nextAccount,
      bots: result.bots ?? [],
      projectKeys: result.projectKeys ?? {},
      allowed: result.allowed !== false,
      mode: nextMode,
      cloudOnly: nextCloudOnly,
    };
  }, []);

  useEffect(() => {
    void loadBots();
    const timer = window.setInterval(() => {
      if (visible()) void loadBots();
    }, LIST_POLL_MS);
    const onFocus = () => void loadBots();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadBots]);

  // Open the primary bot (or the first) when nothing is picked yet. A picked
  // bot missing from a list fetched before it was created stays picked.
  useEffect(() => {
    if (!bots?.length || view !== 'bot' || selectedBotId) return;
    setSidebarV3Settings({ selectedBotId: bots[0].id, view: 'bot' });
  }, [bots, selectedBotId, setSidebarV3Settings, view]);

  // The sidebar is bots only: the primary (all projects) first, then the
  // rest by latest activity, project bots and others alike.
  const sidebarBots = useMemo(() => {
    const list = bots ?? [];
    const primary = list.filter((bot) => bot.role === 'primary');
    const rest = list.filter((bot) => bot.role !== 'primary').sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return [...primary, ...rest];
  }, [bots]);

  const threadsByProject = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const thread of threads) {
      if (thread.parentThreadId) continue;
      const list = map.get(thread.projectId) ?? [];
      list.push(thread);
      map.set(thread.projectId, list);
    }
    for (const list of map.values()) list.sort((a, b) => getThreadActivityTime(b).getTime() - getThreadActivityTime(a).getTime());
    return map;
  }, [threads]);

  // The projects window: projects open here (each with its bot once it
  // exists), then project bots of projects open elsewhere.
  const projectEntries = useMemo<ProjectEntry[]>(() => {
    const list = bots ?? [];
    const here = projects.map((project) => {
      const key = projectKeys[project.id] ?? null;
      return { id: project.id, name: project.name, path: project.path, bot: projectBotFor(list, key ?? undefined), key, threads: threadsByProject.get(project.id) ?? [] };
    });
    const shown = new Set(here.map((entry) => entry.bot?.id).filter(Boolean));
    const elsewhere = list
      .filter((bot) => bot.project && !shown.has(bot.id))
      .map((bot) => ({ id: `bot:${bot.id}`, name: bot.project!.name, path: null, bot, key: bot.project!.key, threads: [] }));
    return [...here, ...elsewhere];
  }, [bots, projectKeys, projects, threadsByProject]);

  const openBot = (botId: string) => setSidebarV3Settings({ selectedBotId: botId, view: 'bot' });
  // A thread opened from a project page shows in a modal over it.
  const [threadModal, setThreadModal] = useState(false);
  const openThreadModal = (threadId: string) => {
    threadActions.selectThread(threadId);
    setThreadModal(true);
  };
  const newThreadInModal = (projectId: string) => {
    onNewThread(projectId);
    setThreadModal(true);
  };
  const closeThreadModal = useCallback(() => setThreadModal(false), []);
  useEffect(() => {
    if (view !== 'project') setThreadModal(false);
  }, [view]);
  const openProjects = () => setSidebarV3Settings({ view: 'projects' });
  const openProject = (projectId: string) => setSidebarV3Settings({ view: 'project', selectedProjectId: projectId });
  // From a project bot's header: its project's page.
  const openProjectOfBot = (bot: DesktopBot) => {
    const entry = projectEntries.find((candidate) => candidate.bot?.id === bot.id);
    openProject(entry?.id ?? `bot:${bot.id}`);
  };
  const botAdded = useCallback(
    (bot: DesktopBot) => {
      setBots((current) => (current && !current.some((item) => item.id === bot.id) ? [...current, bot] : current));
      void loadBots();
    },
    [loadBots]
  );

  const ready = !listError && allowed && bots !== null;
  const projectsActive = view === 'projects' || view === 'project';
  const selectedEntry = view === 'project' ? projectEntries.find((entry) => entry.id === selectedProjectId) ?? null : null;
  return (
    <>
      <div className="sidebar agents-sidebar bots-font" ref={sidebarRef}>
        <div className="px-1.5 pb-1 pt-3">
          <button
            type="button"
            onClick={openProjects}
            className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[14.5px] transition-colors duration-75 ${
              projectsActive ? 'bg-white/[0.08] text-neutral-100' : 'text-neutral-300 hover:bg-white/[0.045]'
            }`}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center text-neutral-400">
              <Folder size={16} />
            </span>
            <span className="flex-1">Projects</span>
            {projects.length > 0 && <span className="text-[12px] text-neutral-500">{projects.length}</span>}
          </button>
        </div>
        <div className="sidebar-top-row flex items-center gap-2 px-3.5 pb-1.5 pt-2">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-neutral-500">Bots</span>
        </div>
        {mode === 'local' && (
          <div className="-mt-1 px-3.5 pb-2 text-[11px] leading-snug text-neutral-500">
            On {THIS_DEVICE} · sign in to Durango to sync
          </div>
        )}
        {cloudOnly && (
          <div className="mx-2.5 mb-2 rounded-lg bg-white/[0.04] px-2.5 py-2 text-[11.5px] leading-snug text-neutral-400 ring-1 ring-white/[0.06]">
            Bot replies on {THIS_DEVICE} are off, so they run in Durango’s cloud.
            <button
              type="button"
              onClick={answerHere}
              className="mt-1.5 block w-full rounded-md bg-white/[0.08] px-2 py-1 text-[12px] font-medium text-neutral-100 hover:bg-white/[0.12]"
            >
              Answer on {THIS_DEVICE}
            </button>
            <span className="mt-1 block text-[10.5px] text-neutral-500">Uses your Claude Code and projects here (Settings → Durango).</span>
          </div>
        )}
        <div className="sidebar-content agents-sidebar-content !pt-0">
          {listError ? (
            <div className="px-3.5 py-2 text-[12.5px] leading-relaxed text-neutral-500">{listError}</div>
          ) : !allowed ? (
            <div className="px-3.5 py-2 text-[12.5px] leading-relaxed text-neutral-500">Bots are part of the Ultra plan on Durango.</div>
          ) : bots === null ? (
            <div className="flex items-center gap-2 px-3.5 py-2 text-[12.5px] text-neutral-500">
              <Loader2 size={13} className="animate-spin" /> Loading bots…
            </div>
          ) : (
            <ul className="px-1.5 pb-3">
              {sidebarBots.map((bot) => (
                <li key={bot.id}>
                  <BotRow
                    bot={bot}
                    title={bot.role === 'primary' ? `${bot.name}: your main bot, across all projects` : bot.project ? `${bot.name}: ${bot.project.name} project` : bot.name}
                    active={view === 'bot' && selectedBotId === bot.id}
                    onClick={() => openBot(bot.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <SidebarFooter {...sidebarFooterProps} />
        {resizeHandle}
      </div>
      {view === 'thread' && ready ? (
        threadPanel
      ) : (
        <div className="panel agents-panel bots-font">
          {!ready ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Bot size={30} />
              </div>
              <div className="empty-state-title">Your bots</div>
              <div className="text-xs text-[#6b6b74]">{listError ?? (allowed ? 'Loading…' : 'Bots are part of the Ultra plan on Durango.')}</div>
            </div>
          ) : view === 'projects' || (view === 'project' && !selectedEntry) ? (
            <ProjectsView entries={projectEntries} onOpen={openProject} />
          ) : view === 'project' && selectedEntry ? (
            <ProjectPage
              key={`${account ?? ''}:${selectedEntry.id}`}
              entry={selectedEntry}
              onBack={openProjects}
              onOpenBot={openBot}
              onNewThread={newThreadInModal}
              onOpenThread={openThreadModal}
              onBotAdded={botAdded}
              threadActions={threadActions}
              attentionThreadIds={attentionThreadIds}
            />
          ) : selectedBotId ? (
            <BotPane key={`${account ?? ''}:${selectedBotId}`} botId={selectedBotId} onChanged={loadBots} onOpenProject={openProjectOfBot} />
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Bot size={30} />
              </div>
              <div className="empty-state-title">Your bots</div>
              <div className="text-xs text-[#6b6b74]">Pick a bot to talk to it.</div>
            </div>
          )}
        </div>
      )}
      {threadModal && view === 'project' && ready && (
        <ThreadModal projectName={selectedEntry?.name ?? 'Project'} onClose={closeThreadModal}>
          {threadPanel}
        </ThreadModal>
      )}
    </>
  );
});

const threadCount = (count: number) => `${count} thread${count === 1 ? '' : 's'}`;

/** The projects window: every project, its bot and threads at a glance. */
const ProjectsView: React.FC<{ entries: ProjectEntry[]; onOpen: (projectId: string) => void }> = ({ entries, onOpen }) => (
  <div className="flex h-full min-h-0 flex-1 flex-col">
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-white/[0.06] px-5">
      <Folder size={15} className="text-neutral-400" />
      <span className="text-[14px] font-semibold text-neutral-100">Projects</span>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[860px] px-5 py-5">
        <p className="mb-4 text-[12.5px] leading-relaxed text-neutral-500">
          Each project has a bot that leads it, its threads, and notes and files its bots and threads keep in mind.
        </p>
        {entries.length === 0 ? (
          <div className="text-[13px] text-neutral-500">No projects yet. Add one from the usual sidebar (Sidebar v3 off) or the Code tab.</div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {entries.map((entry) => {
              const latest = entry.threads[0];
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(entry.id)}
                    className="flex w-full items-start gap-3 rounded-xl bg-white/[0.025] px-3.5 py-3 text-left ring-1 ring-white/[0.06] transition-colors duration-75 hover:bg-white/[0.05]"
                  >
                    <span className="mt-0.5">
                      {entry.bot ? (
                        <BotAvatar bot={entry.bot} size="md" />
                      ) : entry.key ? (
                        // The face its bot will have.
                        <BotAvatar bot={{ emoji: null, name: entry.name, role: 'bot', faceSeed: entry.key }} size="md" />
                      ) : (
                        <ProjectGlyph size="md" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-[13.5px] font-medium text-neutral-100">{entry.name}</span>
                        {entry.bot && botIsWorking(entry.bot) && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />}
                      </span>
                      <span className="block truncate text-[11.5px] text-neutral-500">{entry.path ?? 'On another machine'}</span>
                      <span className="mt-1.5 block truncate text-[11.5px] text-neutral-400">
                        {entry.path ? threadCount(entry.threads.length) : 'Its bot'}
                        {latest ? ` · ${formatShortTime(getThreadActivityTime(latest))} ago` : ''}
                        {entry.bot ? ` · bot ${relativeBotTime(entry.bot.lastActivityAt)}` : ' · no bot yet'}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  </div>
);

type ProjectTab = 'threads' | 'library';

/** A thread's state on the project page (the Threads tab's status cards filter by it). */
type ThreadState = 'needs' | 'working' | 'done' | 'snoozed' | 'settled';

const THREAD_STATES: Record<ThreadState, { label: string; card: string; dot: string; text: string; tint: string; ring: string }> = {
  needs: { label: 'needs you', card: 'Needs you', dot: 'bg-amber-400', text: 'text-amber-300', tint: 'bg-amber-400/[0.08]', ring: 'ring-amber-400/30' },
  working: { label: 'working now', card: 'Working', dot: 'bg-sky-400 animate-pulse', text: 'text-sky-300', tint: 'bg-sky-400/[0.08]', ring: 'ring-sky-400/30' },
  done: { label: 'done, to review', card: 'Done', dot: 'bg-emerald-400', text: 'text-emerald-300', tint: 'bg-emerald-400/[0.07]', ring: 'ring-emerald-400/25' },
  snoozed: { label: 'snoozed', card: 'Snoozed', dot: 'bg-violet-400', text: 'text-violet-300', tint: 'bg-violet-400/[0.07]', ring: 'ring-violet-400/25' },
  settled: { label: 'settled', card: 'Settled', dot: 'bg-neutral-600', text: 'text-neutral-400', tint: 'bg-white/[0.03]', ring: 'ring-white/[0.08]' },
};
const STATUS_CARDS: ThreadState[] = ['needs', 'working', 'done', 'settled'];

const threadStateOf = (thread: Thread, needsYou: boolean): ThreadState => {
  if (thread.settledAt) return 'settled';
  if (thread.snoozedAt) return 'snoozed';
  if (needsYou || threadSidebarTone(thread, false) === 'attention') return 'needs';
  if (thread.status === 'running') return 'working';
  return 'done';
};

/** Who started a thread: a bot (it dispatched it here), Durango (Chat or the API), or the person. */
const threadStarter = (thread: Thread): 'bot' | 'durango' | 'you' => {
  const id = thread.durangoDispatch?.id ?? '';
  if (id.startsWith('bottask:') || id.startsWith('localbot:')) return 'bot';
  return id ? 'durango' : 'you';
};

const ASK_SUGGESTIONS = ['Start a thread to…', 'What changed today?', 'Settle what’s done', 'Fix the failing tests'];

/**
 * One project: its bot and a prompt box to ask it (above both tabs), then
 * Threads (status cards that filter, and the threads, each opening in a
 * modal) and Library (its context notes, files and details). Projects get a
 * bot only when the person creates it (here, or by asking their main bot).
 */
const ProjectPage: React.FC<{
  entry: ProjectEntry;
  onBack: () => void;
  onOpenBot: (botId: string) => void;
  onNewThread: (projectId: string) => void;
  onOpenThread: (threadId: string) => void;
  onBotAdded: (bot: DesktopBot) => void;
  threadActions: SidebarV2Actions;
  attentionThreadIds: ReadonlyMap<string, number>;
}> = ({ entry, onBack, onOpenBot, onNewThread, onOpenThread, onBotAdded, threadActions, attentionThreadIds }) => {
  const [bot, setBot] = useState<DesktopBot | null>(entry.bot);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ProjectTab>('threads');
  const [filter, setFilter] = useState<ThreadState | null>(null);
  const local = !entry.id.startsWith('bot:');
  const threadLists = useMemo(
    () => sidebarV2ThreadLists(entry.threads, (thread) => Boolean(thread.parentThreadId), compareSidebarV2Recent(attentionThreadIds)),
    [entry.threads, attentionThreadIds]
  );
  const stateOf = useCallback((thread: Thread) => threadStateOf(thread, attentionThreadIds.has(thread.id)), [attentionThreadIds]);
  const counts = useMemo(() => {
    const result: Record<ThreadState, number> = { needs: 0, working: 0, done: 0, snoozed: threadLists.snoozed.length, settled: threadLists.settled.length };
    for (const thread of threadLists.recent) result[stateOf(thread)] += 1;
    return result;
  }, [threadLists, stateOf]);
  // No filter: every open thread (not snoozed or settled), newest event first.
  const shown = useMemo(() => {
    if (!filter) return threadLists.recent;
    if (filter === 'snoozed') return threadLists.snoozed;
    if (filter === 'settled') return threadLists.settled;
    return threadLists.recent.filter((thread) => stateOf(thread) === filter);
  }, [filter, threadLists, stateOf]);

  useEffect(() => {
    if (entry.bot) setBot(entry.bot);
  }, [entry.bot]);

  const tabs: { id: ProjectTab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'threads', label: 'Threads', icon: <MessagesSquare size={16} />, count: local ? threadLists.recent.length + threadLists.snoozed.length + threadLists.settled.length : undefined },
    { id: 'library', label: 'Library', icon: <Library size={16} /> },
  ];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/[0.06] px-5">
        <button type="button" onClick={onBack} className="text-[13.5px] text-neutral-500 hover:text-neutral-200">
          Projects
        </button>
        <ChevronRight size={13} className="text-neutral-600" />
        <span className="truncate text-[14.5px] font-semibold text-neutral-100">{entry.name}</span>
        {entry.path && <span className="ml-1 hidden truncate rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-neutral-400 md:inline">{entry.path.replace(/^\/Users\/[^/]+/, '~')}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {local && (
            <button
              type="button"
              onClick={() => onNewThread(entry.id)}
              className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] text-neutral-300 ring-1 ring-white/[0.08] hover:bg-white/[0.06]"
            >
              <Plus size={14} /> New thread
            </button>
          )}
        </span>
      </div>
      {error && <div className="border-b border-white/[0.06] bg-red-500/10 px-5 py-2 text-[12.5px] text-red-300">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-[1080px] px-8 pb-10 pt-7">
          <ProjectBotBox
            entry={entry}
            bot={bot}
            local={local}
            onOpenBot={onOpenBot}
            onBotCreated={(created) => {
              setBot(created);
              onBotAdded(created);
            }}
            onError={setError}
          />
          <nav className="mt-8 flex items-end gap-1 border-b border-white/[0.07]" role="tablist" aria-label="Project">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                onClick={() => setTab(item.id)}
                aria-selected={tab === item.id}
                className={`-mb-px flex h-12 items-center gap-2 border-b-2 px-3 text-[15px] transition-colors duration-75 ${
                  tab === item.id ? 'border-neutral-100 text-neutral-50' : 'border-transparent text-neutral-500 hover:text-neutral-200'
                }`}
              >
                {item.icon}
                {item.label}
                {item.count !== undefined && <span className="text-[12.5px] tabular-nums text-neutral-500">{item.count}</span>}
              </button>
            ))}
          </nav>
          {tab === 'threads' ? (
            !local ? (
              <p className="px-1 py-5 text-[13.5px] text-neutral-500">This project is open on another machine: its threads are there. Ask its bot.</p>
            ) : entry.threads.length === 0 ? (
              <p className="px-1 py-5 text-[13.5px] text-neutral-500">No threads yet. Start one, or ask {bot ? bot.name : 'a bot'} to.</p>
            ) : (
              <>
                <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4" role="radiogroup" aria-label="Show threads">
                  {STATUS_CARDS.map((state) => {
                    const look = THREAD_STATES[state];
                    const active = filter === state;
                    return (
                      <button
                        key={state}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setFilter(active ? null : state)}
                        className={`min-w-0 rounded-2xl p-4 text-left ring-1 transition duration-100 ${look.tint} ${
                          active ? 'ring-2 ring-white/40' : `${look.ring} hover:brightness-125`
                        } ${filter && !active ? 'opacity-55' : ''}`}
                      >
                        <div className={`text-[26px] font-semibold leading-none tabular-nums ${state === 'settled' ? 'text-neutral-400' : look.text}`}>{counts[state]}</div>
                        <div className="mt-2 text-[13px] text-neutral-400">{look.label}</div>
                      </button>
                    );
                  })}
                </div>
                {filter && (
                  <div className="mt-4 flex items-center px-1 text-[13px] text-neutral-500">
                    {THREAD_STATES[filter].card} · {shown.length}
                    <button type="button" onClick={() => setFilter(null)} className="ml-auto text-neutral-400 hover:text-neutral-200">
                      Show all open ›
                    </button>
                  </div>
                )}
                <div className="mt-3">
                  {shown.length === 0 ? (
                    <p className="px-1 py-4 text-[13.5px] text-neutral-500">
                      {filter ? `No threads ${THREAD_STATES[filter].label}.` : 'Nothing open: every thread is snoozed or settled.'}
                    </p>
                  ) : (
                    shown.map((thread) => (
                      <ProjectThreadRow
                        key={thread.id}
                        thread={thread}
                        state={stateOf(thread)}
                        bot={bot}
                        actions={threadActions}
                        onOpen={() => onOpenThread(thread.id)}
                      />
                    ))
                  )}
                  {!filter && counts.snoozed > 0 && (
                    <button type="button" onClick={() => setFilter('snoozed')} className="mt-1 px-1 py-2 text-[13px] text-neutral-500 hover:text-neutral-300">
                      {counts.snoozed} snoozed ›
                    </button>
                  )}
                </div>
              </>
            )
          ) : (
            <div className="-mx-3.5">
              <ProjectLibrary
                key={entry.id}
                target={local ? { projectId: entry.id } : { botId: bot!.id }}
                name={entry.name}
                path={entry.path}
                bot={bot}
                onOpenBot={onOpenBot}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * The project's bot and a box to ask it something, above both tabs. With no
 * bot yet, sending creates it first (projects get one only when asked).
 */
const ProjectBotBox: React.FC<{
  entry: ProjectEntry;
  bot: DesktopBot | null;
  local: boolean;
  onOpenBot: (botId: string) => void;
  onBotCreated: (bot: DesktopBot) => void;
  onError: (error: string | null) => void;
}> = ({ entry, bot, local, onOpenBot, onBotCreated, onError }) => {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'create' | 'send' | null>(null);
  const [sent, setSent] = useState(false);
  const botId = bot?.id ?? null;
  const libraryTarget = useMemo<BotProjectTarget | null>(
    () => (local ? { projectId: entry.id } : botId ? { botId } : null),
    [entry.id, local, botId]
  );
  const countsOf = (project: BotProject | null | undefined) => (project ? { notes: project.notes.length, files: project.files.length } : null);
  const [library, setLibrary] = useState<{ notes: number; files: number } | null>(() =>
    libraryTarget ? countsOf(botProjectCache.get(projectCacheKey(libraryTarget))) : null
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!libraryTarget) return undefined;
    const generation = botCacheGeneration;
    void window.orion?.getBotProject?.(libraryTarget).then((result) => {
      if (cancelled || !result?.ok || generation !== botCacheGeneration) return;
      botProjectCache.set(projectCacheKey(libraryTarget), result.project ?? null);
      setLibrary(countsOf(result.project));
    });
    return () => {
      cancelled = true;
    };
  }, [libraryTarget]);

  const ensureBot = async (): Promise<DesktopBot | null> => {
    if (bot) return bot;
    setBusy('create');
    onError(null);
    const result = await window.orion?.ensureProjectBot?.({ projectId: entry.id });
    setBusy(null);
    if (!result?.ok || !result.bot) {
      onError(result?.error ?? 'Couldn’t create this project’s bot.');
      return null;
    }
    onBotCreated(result.bot);
    return result.bot;
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    const target = await ensureBot();
    if (!target) return;
    setBusy('send');
    onError(null);
    let timeZone: string | undefined;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timeZone = undefined;
    }
    const result = await window.orion?.sendBotMessage?.({ botId: target.id, messageId: newBotMessageId(), content, ...(timeZone ? { timeZone } : {}) });
    setBusy(null);
    if (!result?.ok) {
      onError(result?.error ?? 'Couldn’t send that.');
      return;
    }
    setDraft('');
    setSent(true);
  };

  const name = bot?.name ?? entry.name;
  const faceBot: FaceBot = bot ?? { emoji: null, name: entry.name, role: 'bot', faceSeed: entry.key ?? entry.id };
  const status = bot
    ? botIsWorking(bot)
      ? <span className="text-sky-300">working</span>
      : bot.needsYou
        ? <span className="text-amber-300">waiting on you</span>
        : <>active {relativeBotTime(bot.lastActivityAt)}</>
    : null;

  return (
    <div>
      <div className="flex items-center gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-white/[0.04] text-[28px] ring-1 ring-white/[0.07]">
          <BotIcon bot={faceBot} px={38} />
        </span>
        <div className="min-w-0 flex-1">
          {bot ? (
            <button type="button" onClick={() => onOpenBot(bot.id)} className="flex items-center gap-2 text-[22px] font-semibold text-neutral-50 hover:text-white" title={`Open the conversation with ${bot.name}`}>
              {bot.name}
              {bot.unread > 0 && <span className="rounded-full bg-sky-500 px-1.5 text-[11px] font-semibold leading-[18px] text-white">{bot.unread}</span>}
            </button>
          ) : (
            <div className="text-[22px] font-semibold text-neutral-50">{entry.name}</div>
          )}
          <div className="truncate text-[14px] text-neutral-400">
            {bot ? 'The project bot' : 'No bot yet: send a message and one is made for this project'}
            {library && (library.notes || library.files) ? ` · knows ${library.notes} note${library.notes === 1 ? '' : 's'} and ${library.files} file${library.files === 1 ? '' : 's'}` : ''}
            {status && <> · {status}</>}
          </div>
        </div>
      </div>
      {(bot || local) && (
        <div className="mt-5 rounded-2xl bg-white/[0.035] p-3.5 ring-1 ring-white/[0.08] focus-within:ring-white/[0.16]">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSent(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={`Ask ${name} to do something in this project…`}
            className="max-h-[220px] min-h-[48px] w-full resize-none bg-transparent px-1 text-[15px] leading-relaxed text-neutral-100 outline-none placeholder:text-neutral-500"
          />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {sent && bot ? (
              <span className="flex items-center gap-1.5 px-1 text-[13px] text-neutral-400">
                <Check size={14} className="text-emerald-400" /> Sent to {bot.name}.
                <button type="button" onClick={() => onOpenBot(bot.id)} className="text-neutral-300 underline-offset-2 hover:underline">
                  Open the conversation ›
                </button>
              </span>
            ) : (
              ASK_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setDraft(suggestion.endsWith('…') ? suggestion.slice(0, -1) + ' ' : suggestion);
                    inputRef.current?.focus();
                  }}
                  className="rounded-full bg-white/[0.05] px-3 py-1 text-[12.5px] text-neutral-300 ring-1 ring-white/[0.06] hover:bg-white/[0.09]"
                >
                  {suggestion}
                </button>
              ))
            )}
            <button
              type="button"
              disabled={!draft.trim() || busy !== null}
              onClick={() => void send()}
              className="ml-auto flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.1] px-3 text-[13px] font-medium text-neutral-100 hover:bg-white/[0.15] disabled:opacity-40"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={13} />}
              {busy === 'create' ? 'Making its bot…' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/** A thread on the project page: state, title, what it's doing, who started it, when; quick actions on hover. */
const ProjectThreadRow: React.FC<{
  thread: Thread;
  state: ThreadState;
  bot: DesktopBot | null;
  actions: SidebarV2Actions;
  onOpen: () => void;
}> = ({ thread, state, bot, actions, onOpen }) => {
  const look = THREAD_STATES[state];
  const starter = threadStarter(thread);
  const model = actions.modelLabel(thread);
  const unseen = Boolean(thread.finishedUnseenAt);
  const detail =
    state === 'working'
      ? `Working${thread.summary.workingSince ? ` for ${formatShortTime(new Date(thread.summary.workingSince))}` : ''}`
      : state === 'needs'
        ? thread.status === 'error'
          ? 'Its run failed: take a look'
          : 'Waiting on you: a question or approval'
        : state === 'snoozed'
          ? 'Snoozed'
          : state === 'settled'
            ? 'Settled'
            : unseen
              ? 'Finished · not opened yet'
              : `${thread.summary.messageCount} message${thread.summary.messageCount === 1 ? '' : 's'}`;
  const quick = (label: string, run: () => void) => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        run();
      }}
      className="rounded-md px-2 py-1 text-[12px] text-neutral-400 hover:bg-white/[0.07] hover:text-neutral-100"
    >
      {label}
    </button>
  );
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group flex cursor-pointer items-center gap-3.5 border-b border-white/[0.05] px-2 py-3 outline-none transition-colors duration-75 hover:bg-white/[0.025] focus-visible:bg-white/[0.04]"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${look.dot}`} aria-label={look.card} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {thread.pinnedAt && <Pin size={12} className="shrink-0 text-neutral-500" />}
          <span className={`truncate text-[15px] ${unseen || state === 'needs' ? 'font-medium text-neutral-50' : 'text-neutral-100'}`}>{thread.title || 'New thread'}</span>
        </div>
        <div className={`mt-0.5 truncate text-[13px] ${state === 'needs' ? 'text-amber-200/80' : state === 'working' ? 'text-sky-300/80' : 'text-neutral-500'}`}>
          {detail}
          {model ? <span className="text-neutral-600"> · {model}</span> : null}
        </div>
      </div>
      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        {thread.pinnedAt ? quick('Unpin', () => actions.unpinThread(thread.id)) : quick('Pin', () => actions.pinThread(thread.id))}
        {!thread.settledAt && (thread.snoozedAt ? quick('Wake', () => actions.unsnoozeThread(thread.id)) : quick('Snooze', () => actions.snoozeThread(thread.id)))}
        {thread.settledAt ? quick('Reopen', () => actions.unsettleThread(thread.id)) : quick('Settle', () => actions.settleThread(thread.id))}
      </div>
      <span className="flex w-28 shrink-0 items-center gap-1.5 truncate text-[12.5px] text-neutral-400">
        {starter === 'bot' ? (
          <>
            {bot ? <BotIcon bot={bot} px={14} /> : <Bot size={13} />} {bot?.name ?? 'A bot'}
          </>
        ) : starter === 'durango' ? (
          <>✨ Durango</>
        ) : (
          <>
            <UserRound size={13} /> You
          </>
        )}
      </span>
      <span className="w-12 shrink-0 text-right text-[12.5px] tabular-nums text-neutral-500">{formatShortTime(getThreadActivityTime(thread))}</span>
    </div>
  );
};

/**
 * A thread opened from a project page: the usual thread view (App's agents
 * panel, with its subagents, prompt box and pickers) in a large modal. Esc
 * (when no menu of the thread view is open), ✕ or a click outside closes it.
 */
// Open menus and pickers of the thread view (App.tsx): Esc closes them before the modal.
const THREAD_VIEW_OPEN_MENUS = [
  '[role="menu"]',
  '[role="listbox"]',
  '[aria-haspopup][aria-expanded="true"]',
  '[class*="popover"]',
  '.model-trigger-chevron.open',
  '.shell-branch-picker',
  '.thread-menu',
  '.shell-openwith-menu',
  '[class*="composer-menu"]',
].join(', ');

const ThreadModal: React.FC<{ projectName: string; onClose: () => void; children: React.ReactNode }> = ({ projectName, onClose, children }) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const thread = useOrionStore((state) => state.threads.find((item) => item.id === state.selectedThreadId) ?? null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const panel = panelRef.current;
      // A picker or menu of the thread view is open: Esc closes that first.
      if (panel?.querySelector(THREAD_VIEW_OPEN_MENUS)) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);
  return (
    <div
      className="bots-thread-modal fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-7 backdrop-blur-[3px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Thread"
    >
      <div ref={panelRef} className="bots-thread-modal-panel relative flex h-full max-h-[1000px] w-full max-w-[1280px] flex-col overflow-hidden rounded-2xl bg-[#111113] shadow-[0_30px_120px_rgba(0,0,0,0.6)] ring-1 ring-white/[0.1]">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/[0.06] pl-5 pr-2.5">
          <span className="shrink-0 text-[14px] text-neutral-500">{projectName}</span>
          <span className="text-neutral-600">/</span>
          <span className="min-w-0 truncate text-[15px] font-semibold text-neutral-100">{thread?.title || 'New thread'}</span>
          {thread?.status === 'running' && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" aria-label="Working" />}
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
            className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 hover:bg-white/[0.08] hover:text-neutral-100"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
};

const ProjectGlyph: React.FC<{ size?: 'sm' | 'md' }> = ({ size = 'sm' }) => (
  <span
    className={`inline-flex shrink-0 items-center justify-center rounded-[10px] bg-white/[0.03] text-neutral-500 ring-1 ring-white/[0.06] ${
      size === 'md' ? 'h-8 w-8' : 'h-6 w-6'
    }`}
    aria-hidden
  >
    <Folder size={size === 'md' ? 14 : 12} />
  </span>
);

/** A compact one-line sidebar row: icon, name, and unread count or a working / waiting dot. */
const BotRow: React.FC<{
  bot: DesktopBot;
  title: string;
  active: boolean;
  onClick: () => void;
}> = ({ bot, title, active, onClick }) => {
  const working = botIsWorking(bot);
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-75 ${
        active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.045]'
      }`}
    >
      <span className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center text-[15px] leading-none" aria-hidden>
        <BotIcon bot={bot} px={22} />
        {bot.role === 'primary' && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[14.5px] ${bot.unread > 0 ? 'font-semibold text-neutral-100' : 'text-neutral-300'}`}>
        {bot.name}
      </span>
      {bot.unread > 0 ? (
        <span className="shrink-0 rounded-full bg-sky-500 px-1.5 text-[11px] font-semibold leading-[18px] text-white">{bot.unread}</span>
      ) : working ? (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />
      ) : bot.needsYou ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
      ) : bot.paused ? (
        <Pause size={11} className="shrink-0 text-neutral-600" />
      ) : null}
    </button>
  );
};

/** One bot's conversation: messages, live replies at the bottom, and a composer that never blocks. */
const BotPane: React.FC<{ botId: string; onChanged: () => void; onOpenProject: (bot: DesktopBot) => void }> = ({ botId, onChanged, onOpenProject }) => {
  const [thread, setThread] = useState<DesktopBotThread | null>(() => botThreadCache.get(botId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const working = thread ? botIsWorking(thread.bot) : false;
  const sending = outgoing.some((message) => !message.failed);

  const load = useCallback(async () => {
    const generation = botCacheGeneration;
    const result = await window.orion?.getBotThread?.({ botId, limit: 120, read: visible() });
    if (!result || generation !== botCacheGeneration) return;
    if (!result.ok || !result.bot) {
      setError(result.error ?? 'Couldn’t load this bot.');
      return;
    }
    setError(null);
    botThreadCache.set(botId, result as DesktopBotThread);
    setThread(result as DesktopBotThread);
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Brisk while a reply is being written (or just sent), slow otherwise.
  useEffect(() => {
    const timer = window.setTimeout(function tick() {
      if (visible()) void load();
    }, working || sending ? THREAD_POLL_ACTIVE_MS : THREAD_POLL_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [load, thread, working, sending]);

  const stored = useMemo(() => new Set(thread?.messages.map((message) => message.id) ?? []), [thread]);
  const pending = outgoing.filter((message) => !stored.has(message.id));

  const send = useCallback(
    async (text: string, files: BotAttachmentFile[] = [], id = newBotMessageId()) => {
      const content = text.trim();
      if (!content && !files.length) return;
      stick.current = true;
      setOutgoing((current) => [...current.filter((message) => message.id !== id), { id, content, ...(files.length ? { files } : {}) }]);
      let timeZone: string | undefined;
      try {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        timeZone = undefined;
      }
      const result = await window.orion?.sendBotMessage?.({
        botId,
        messageId: id,
        content,
        ...(files.length ? { files } : {}),
        ...(timeZone ? { timeZone } : {}),
      });
      if (!result?.ok) {
        setOutgoing((current) => current.map((message) => (message.id === id ? { ...message, failed: result?.error ?? 'Couldn’t send.' } : message)));
        return;
      }
      void load();
      onChanged();
    },
    [botId, load, onChanged]
  );

  const liveKey = thread?.live.map((reply) => `${reply.messageId}:${reply.content.length}`).join() ?? '';
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [thread?.messages.length, pending.length, liveKey]);

  if (!thread) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-neutral-500">
        {error ?? <Loader2 size={16} className="animate-spin" />}
      </div>
    );
  }
  const { bot } = thread;
  const live = thread.live.filter((reply) => !stored.has(reply.messageId));
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-white/[0.06] px-4">
        <BotAvatar bot={bot} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-neutral-100">{bot.name}</span>
            {bot.role === 'primary' && <span className="shrink-0 text-[11px] text-neutral-500">all projects</span>}
          </div>
          <div className="flex items-center gap-1.5 text-[11.5px] text-neutral-500">
            {bot.paused ? <Pause size={11} /> : working ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> : null}
            {bot.paused ? 'Paused' : working ? (live.length > 1 ? `Working on ${live.length} replies…` : 'Working…') : bot.needsYou ? 'Waiting on you' : bot.model.split('/').pop()}
          </div>
        </div>
        {bot.project && (
          <button
            type="button"
            onClick={() => onOpenProject(bot)}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-neutral-400 transition-colors duration-75 hover:bg-white/[0.06] hover:text-neutral-200"
            title="The project: its threads, notes and files"
          >
            <FolderOpen size={13} /> {bot.project.name}
          </button>
        )}
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }}
      >
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-5 pb-6 pt-5">
          {thread.messages.length === 0 && pending.length === 0 && !working && (
            <div className="mt-16 text-center text-[13px] leading-relaxed text-neutral-500">
              Text {bot.name} like a person: send as many messages as you like.
            </div>
          )}
          {thread.messages.map((message) => (
            <BotMessage key={message.id} bot={bot} message={message} />
          ))}
          {pending.map((message) => (
            <PersonBubble
              key={message.id}
              content={message.content}
              files={message.files}
              meta={
                message.failed ? (
                  <button type="button" className="text-red-400 hover:underline" onClick={() => void send(message.content, message.files ?? [], message.id)}>
                    {message.failed} Retry
                  </button>
                ) : (
                  'Sending…'
                )
              }
            />
          ))}
          {live.map((reply) => (
            <AssistantRow key={`live-${reply.messageId}`} bot={bot}>
              {reply.content ? <MarkdownContent content={reply.content} /> : null}
              <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-neutral-500">
                <Loader2 size={11} className="animate-spin" />
                {reply.activeTool ? `Using ${reply.activeTool}` : reply.content ? 'Writing…' : 'Thinking…'}
                {reply.place === LOCAL_BOT_PLACE ? (
                  <span className="text-neutral-600">· on {THIS_DEVICE}</span>
                ) : reply.place !== 'cloud' ? (
                  <span className="text-neutral-600">· on your machine</span>
                ) : null}
              </div>
            </AssistantRow>
          ))}
          {working && live.length === 0 && (
            <AssistantRow bot={bot}>
              <div className="flex items-center gap-1.5 text-[11.5px] text-neutral-500">
                <Loader2 size={11} className="animate-spin" /> Starting…
              </div>
            </AssistantRow>
          )}
        </div>
      </div>
      <BotComposer botName={bot.name} paused={bot.paused} onSend={(text, files) => void send(text, files)} />
    </div>
  );
};

type ProjectActionInput = Parameters<NonNullable<NonNullable<typeof window.orion>['botProjectAction']>>[0];
type ProjectActionResult = Awaited<ReturnType<NonNullable<NonNullable<typeof window.orion>['botProjectAction']>>>;

const NOTE_MAX_CHARS = 2_000;
const NOTE_MAX_COUNT = 200;
const NOTE_UNDO_MS = 5_000;
const NOTE_FILTER_FROM = 6;
/** In one column, notes past this many fold away so the files stay in reach. */
const NOTE_FOLD_AT = 4;
const NOTE_EXAMPLES = ['Use bun for scripts, never npm.', 'Ask before changing the database schema.', 'Write copy in plain US English.'];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** `/Users/me/x` → `~/x`. */
const shortPath = (value: string) => value.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
/** relativeBotTime as a phrase: "just now", "2h ago", "Nov 3". */
const agoLabel = (ms: number) => {
  const value = relativeBotTime(ms);
  return value === 'now' ? 'just now' : /^\d+[mhd]$/.test(value) ? `${value} ago` : value;
};
const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

const CODE_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'py', 'rb', 'rs', 'go', 'swift', 'kt', 'java', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'sql', 'css', 'scss', 'html']);
const DATA_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml', 'xml', 'env']);
const SHEET_EXTENSIONS = new Set(['csv', 'tsv', 'xls', 'xlsx', 'numbers']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', 'tgz', 'tar', '7z', 'rar']);

/** A file's icon, tint and short type label, by its type and extension. */
const fileKind = (file: Pick<BotProjectFile, 'name' | 'contentType'>) => {
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  const type = file.contentType || '';
  const label = ext ? ext.toUpperCase() : type.split('/')[1]?.toUpperCase() || 'File';
  if (type.startsWith('image/')) return { icon: FileImage, tint: 'text-sky-300', label, image: true };
  if (type === 'application/pdf') return { icon: FileText, tint: 'text-rose-300', label: 'PDF', image: false };
  if (type.startsWith('video/')) return { icon: FileVideo, tint: 'text-violet-300', label, image: false };
  if (type.startsWith('audio/')) return { icon: FileAudio, tint: 'text-violet-300', label, image: false };
  if (SHEET_EXTENSIONS.has(ext)) return { icon: FileSpreadsheet, tint: 'text-emerald-300', label, image: false };
  if (ARCHIVE_EXTENSIONS.has(ext)) return { icon: FileArchive, tint: 'text-amber-300', label, image: false };
  if (DATA_EXTENSIONS.has(ext)) return { icon: FileJson, tint: 'text-amber-200', label, image: false };
  if (CODE_EXTENSIONS.has(ext)) return { icon: FileCode, tint: 'text-amber-200', label, image: false };
  if (type.startsWith('text/') || ext === 'md' || ext === 'txt') return { icon: FileText, tint: 'text-neutral-300', label, image: false };
  return { icon: File, tint: 'text-neutral-400', label, image: false };
};

/** A small icon button, as the library's rows and cards use them. */
const LibraryIconButton: React.FC<{ label: string; onClick: () => void; children: React.ReactNode; danger?: boolean; disabled?: boolean }> = ({
  label,
  onClick,
  children,
  danger,
  disabled,
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors duration-75 hover:bg-white/[0.08] disabled:opacity-40 ${
      danger ? 'hover:text-red-300' : 'hover:text-neutral-100'
    }`}
  >
    {children}
  </button>
);

/** A panel of the library: icon, title, count, a line on what it's for, and its contents. */
const LibraryPanel: React.FC<{
  icon: React.ReactNode;
  title: string;
  count?: number;
  description: React.ReactNode;
  actions?: React.ReactNode;
  overlay?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, count, description, actions, overlay, children }) => (
  <section className="relative flex min-w-0 flex-col rounded-xl bg-white/[0.02] ring-1 ring-white/[0.06]">
    <header className="flex h-7 items-center gap-2.5 px-4 mt-3.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-neutral-300 ring-1 ring-white/[0.07]">{icon}</span>
      <h3 className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px] font-semibold text-neutral-100">
        {title}
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-white/[0.07] px-1.5 text-[10.5px] font-medium tabular-nums leading-4 text-neutral-400">{count}</span>
        )}
      </h3>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
    <p className="mt-1 px-4 text-[12px] leading-snug text-neutral-500">{description}</p>
    <div className="px-3 pb-3 pt-3">{children}</div>
    {overlay}
  </section>
);

/** The strip above the panels: where the project lives, and who reads its library. */
const LibraryAbout: React.FC<{ path: string | null; bot: DesktopBot | null; onOpenBot: (botId: string) => void }> = ({ path, bot, onOpenBot }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-white/[0.02] px-2 py-1.5 ring-1 ring-white/[0.06]">
      <div className="flex min-w-0 flex-1 basis-[280px] items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-neutral-400 ring-1 ring-white/[0.07]">
          <Folder size={13} />
        </span>
        {path ? (
          <>
            <span className="min-w-0 truncate font-mono text-[12px] text-neutral-300" title={path}>
              {shortPath(path)}
            </span>
            <span className="flex shrink-0 items-center">
              <LibraryIconButton label={isMac ? 'Open in Finder' : 'Open folder'} onClick={() => void window.orion?.openProjectWith?.({ appId: 'finder', projectPath: path })}>
                <FolderOpen size={13} />
              </LibraryIconButton>
              <LibraryIconButton label={copied ? 'Copied' : 'Copy path'} onClick={() => void navigator.clipboard?.writeText(path).then(() => setCopied(true))}>
                {copied ? <Check size={13} className="text-emerald-300" /> : <Copy size={13} />}
              </LibraryIconButton>
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate text-[12px] text-neutral-400">On another machine: its folder and threads are there.</span>
        )}
      </div>
      {bot ? (
        <button
          type="button"
          onClick={() => onOpenBot(bot.id)}
          title={`Open ${bot.name}`}
          className="flex min-w-0 items-center gap-2 rounded-lg py-1 pl-1.5 pr-2.5 text-[12px] text-neutral-400 transition-colors duration-75 hover:bg-white/[0.05] hover:text-neutral-200"
        >
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[13px]" aria-hidden>
            <BotIcon bot={bot} px={18} />
          </span>
          <span className="truncate">
            Read by <span className="font-medium text-neutral-200">{bot.name}</span> and the threads it starts
          </span>
          {botIsWorking(bot) && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-[12px] text-neutral-500">
          <Bot size={14} className="shrink-0" />
          <span className="truncate">No bot yet. A project bot keeps this library in mind.</span>
        </span>
      )}
    </div>
  );
};

const NoteAuthor: React.FC<{ author: string; bot: DesktopBot | null }> = ({ author, bot }) =>
  bot && author === bot.name ? (
    <span className="flex h-3.5 w-3.5 items-center justify-center text-[10px]" aria-hidden>
      <BotIcon bot={bot} px={14} />
    </span>
  ) : (
    <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white/[0.08] text-neutral-400" aria-hidden>
      <UserRound size={9} />
    </span>
  );

const NoteCard: React.FC<{ note: BotProjectNote; bot: DesktopBot | null; onDelete: () => void }> = ({ note, bot, onDelete }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = note.content.length > 360 || note.content.split('\n').length > 6;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <li className="group rounded-lg bg-white/[0.03] px-3 pb-1.5 pt-2.5 ring-1 ring-white/[0.05] transition-colors duration-75 hover:bg-white/[0.04] hover:ring-white/[0.08]">
      <div
        className={`whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-neutral-200 ${
          long && !expanded ? 'max-h-[9.3em] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : ''
        }`}
      >
        {note.content}
      </div>
      <div className="mt-1.5 flex h-6 items-center gap-1.5 text-[11px] text-neutral-500">
        <NoteAuthor author={note.author} bot={bot} />
        <span className="truncate">{note.author}</span>
        <span className="text-neutral-700">·</span>
        <span className="shrink-0" title={new Date(note.createdAt).toLocaleString()}>
          {agoLabel(note.createdAt)}
        </span>
        {long && (
          <button type="button" onClick={() => setExpanded((value) => !value)} className="ml-1 shrink-0 text-neutral-400 hover:text-neutral-100">
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <span className="ml-auto flex items-center opacity-0 transition-opacity duration-75 focus-within:opacity-100 group-hover:opacity-100">
          <LibraryIconButton label={copied ? 'Copied' : 'Copy note'} onClick={() => void navigator.clipboard?.writeText(note.content).then(() => setCopied(true))}>
            {copied ? <Check size={12} className="text-emerald-300" /> : <Copy size={12} />}
          </LibraryIconButton>
          <LibraryIconButton label="Delete note" danger onClick={onDelete}>
            <Trash2 size={12} />
          </LibraryIconButton>
        </span>
      </div>
    </li>
  );
};

/** The quick add: one line that grows, Enter adds, Shift+Enter starts a new line. */
const NoteComposer: React.FC<{ full: boolean; onAdd: (content: string) => Promise<boolean>; seed: { text: string; at: number } | null }> = ({ full, onAdd, seed }) => {
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [draft]);
  useEffect(() => {
    if (!seed) return;
    setDraft(seed.text);
    ref.current?.focus();
  }, [seed]);
  const submit = async () => {
    const content = draft.trim();
    if (!content || adding) return;
    setAdding(true);
    const ok = await onAdd(content);
    setAdding(false);
    if (ok) setDraft('');
    ref.current?.focus();
  };
  if (full) {
    return (
      <div className="rounded-lg bg-white/[0.02] px-3 py-2 text-[12px] text-neutral-500 ring-1 ring-white/[0.05]">
        This project has {NOTE_MAX_COUNT} notes, the most it keeps. Delete one to add another.
      </div>
    );
  }
  const length = draft.length;
  return (
    <div className="rounded-lg bg-white/[0.03] ring-1 ring-white/[0.07] transition-colors duration-75 focus-within:bg-white/[0.045] focus-within:ring-white/[0.16]">
      <div className="flex items-start gap-2 px-3 py-2">
        <Plus size={14} className="mt-[3px] shrink-0 text-neutral-500" />
        <textarea
          ref={ref}
          value={draft}
          rows={1}
          aria-label="New note"
          placeholder="Add a note for the bots…"
          onChange={(event) => setDraft(event.target.value.slice(0, NOTE_MAX_CHARS))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            } else if (event.key === 'Escape' && draft) {
              event.preventDefault();
              setDraft('');
            }
          }}
          className="max-h-[240px] min-h-[20px] flex-1 resize-none bg-transparent text-[13px] leading-5 text-neutral-100 outline-none placeholder:text-neutral-500"
        />
      </div>
      {draft.trim() && (
        <div className="flex items-center gap-3 border-t border-white/[0.05] px-3 py-1.5 text-[11px] text-neutral-500">
          <span className={`tabular-nums ${length > NOTE_MAX_CHARS * 0.9 ? 'text-amber-300' : ''}`}>
            {length.toLocaleString()} / {NOTE_MAX_CHARS.toLocaleString()}
          </span>
          <span className="ml-auto hidden sm:inline">Shift ↵ for a new line</span>
          <button
            type="button"
            disabled={adding}
            onClick={() => void submit()}
            className="flex h-6 items-center gap-1.5 rounded-md bg-neutral-100 px-2 text-[11.5px] font-medium text-neutral-900 transition-opacity hover:bg-white disabled:opacity-50"
          >
            {adding ? <Loader2 size={11} className="animate-spin" /> : <CornerDownLeft size={11} />} Add note
          </button>
        </div>
      )}
    </div>
  );
};

/** Context: the notes every bot on the project keeps in mind. Deleting waits a moment, so it can be undone. */
const ContextPanel: React.FC<{
  notes: BotProjectNote[] | null;
  bot: DesktopBot | null;
  onAdd: (content: string) => Promise<boolean>;
  onDelete: (noteId: string) => void;
  /** One column: fold long lists. */
  fold: boolean;
}> = ({ notes, bot, onAdd, onDelete, fold }) => {
  const [removed, setRemoved] = useState<Map<string, 'undo' | 'gone'>>(new Map());
  const timers = useRef(new Map<string, number>());
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const [query, setQuery] = useState('');
  const [seed, setSeed] = useState<{ text: string; at: number } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const mark = (noteId: string, state: 'undo' | 'gone' | null) =>
    setRemoved((current) => {
      const next = new Map(current);
      if (state) next.set(noteId, state);
      else next.delete(noteId);
      return next;
    });
  const remove = (noteId: string) => {
    mark(noteId, 'undo');
    timers.current.set(
      noteId,
      window.setTimeout(() => {
        timers.current.delete(noteId);
        mark(noteId, 'gone');
        onDeleteRef.current(noteId);
      }, NOTE_UNDO_MS)
    );
  };
  const undo = (noteId: string) => {
    window.clearTimeout(timers.current.get(noteId));
    timers.current.delete(noteId);
    mark(noteId, null);
  };
  // Leaving the page deletes the notes still waiting.
  useEffect(
    () => () => {
      for (const [noteId, timer] of timers.current) {
        window.clearTimeout(timer);
        onDeleteRef.current(noteId);
      }
      timers.current.clear();
    },
    []
  );

  const kept = (notes ?? []).filter((note) => removed.get(note.id) !== 'gone');
  const count = kept.filter((note) => !removed.has(note.id)).length;
  const needle = query.trim().toLowerCase();
  const shown = needle ? kept.filter((note) => note.content.toLowerCase().includes(needle) || note.author.toLowerCase().includes(needle)) : kept;
  const filterable = count >= NOTE_FILTER_FROM || needle !== '';
  const folded = fold && !showAll && !needle && shown.length > NOTE_FOLD_AT + 1;
  const visibleNotes = folded ? shown.slice(0, NOTE_FOLD_AT) : shown;

  return (
    <LibraryPanel
      icon={<NotebookPen size={14} />}
      title="Context"
      count={count}
      description="Facts, rules and decisions the bots keep in mind."
      actions={
        filterable ? (
          <label className="flex h-7 w-40 items-center gap-1.5 rounded-md bg-white/[0.03] px-2 text-neutral-500 ring-1 ring-white/[0.07] focus-within:ring-white/[0.16]">
            <Search size={12} className="shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('');
              }}
              placeholder="Filter notes"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-neutral-100 outline-none placeholder:text-neutral-500"
            />
            {query && (
              <button type="button" aria-label="Clear filter" onClick={() => setQuery('')} className="text-neutral-500 hover:text-neutral-200">
                <X size={11} />
              </button>
            )}
          </label>
        ) : undefined
      }
    >
      <NoteComposer full={count >= NOTE_MAX_COUNT} onAdd={onAdd} seed={seed} />
      {notes === null ? (
        <div className="mt-2.5 space-y-2" aria-hidden>
          {[0, 1].map((index) => (
            <div key={index} className="h-[68px] animate-pulse rounded-lg bg-white/[0.025]" />
          ))}
        </div>
      ) : kept.length === 0 ? (
        <div className="mt-2.5 rounded-lg border border-dashed border-white/[0.08] px-4 py-4">
          <div className="text-[12.5px] text-neutral-300">No context yet</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-neutral-500">
            Short facts every bot on this project should know: goals, conventions, people to ask, things to avoid. For example:
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {NOTE_EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setSeed({ text: example, at: Date.now() })}
                className="rounded-full bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-neutral-400 ring-1 ring-white/[0.07] transition-colors duration-75 hover:bg-white/[0.08] hover:text-neutral-100"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      ) : shown.length === 0 ? (
        <p className="mt-3 px-1 text-[12px] text-neutral-500">No notes match “{query.trim()}”.</p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {visibleNotes.map((note) =>
            removed.get(note.id) === 'undo' ? (
              <li key={note.id} className="flex h-9 items-center gap-2 rounded-lg bg-white/[0.015] px-3 text-[12px] text-neutral-500 ring-1 ring-white/[0.05]">
                <Trash2 size={12} className="shrink-0 text-neutral-600" />
                <span className="min-w-0 flex-1 truncate">
                  Deleted <span className="text-neutral-600">“{note.content.split('\n')[0]}”</span>
                </span>
                <button
                  type="button"
                  onClick={() => undo(note.id)}
                  className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-neutral-200 hover:bg-white/[0.08]"
                >
                  <Undo2 size={12} /> Undo
                </button>
              </li>
            ) : (
              <NoteCard key={note.id} note={note} bot={bot} onDelete={() => remove(note.id)} />
            )
          )}
        </ul>
      )}
      {folded && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 flex h-8 w-full items-center justify-center gap-1 rounded-lg text-[12px] text-neutral-400 ring-1 ring-white/[0.06] transition-colors duration-75 hover:bg-white/[0.04] hover:text-neutral-100"
        >
          Show all {shown.length} notes
        </button>
      )}
    </LibraryPanel>
  );
};

const FileThumb: React.FC<{ file: BotProjectFile }> = ({ file }) => {
  const kind = fileKind(file);
  const [broken, setBroken] = useState(false);
  const Icon = kind.icon;
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.04] ring-1 ring-white/[0.07]">
      {kind.image && file.url && !broken ? (
        <img src={file.url} alt="" draggable={false} loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-cover" />
      ) : (
        <Icon size={16} strokeWidth={1.75} className={kind.tint} />
      )}
    </span>
  );
};

const FileRow: React.FC<{ file: BotProjectFile; bot: DesktopBot | null; onOpen: () => void; onDelete: () => Promise<void> }> = ({ file, bot, onOpen, onDelete }) => {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const kind = fileKind(file);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  return (
    <li
      className={`group flex items-center gap-1 rounded-lg pr-1.5 transition-colors duration-75 hover:bg-white/[0.04] ${deleting ? 'opacity-40' : ''}`}
      onMouseLeave={() => setConfirming(false)}
    >
      <button type="button" onClick={onOpen} title={`Open ${file.name}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1.5 py-1.5 text-left">
        <FileThumb file={file} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-5 text-neutral-200">{file.name}</span>
          <span className="flex items-center gap-1 truncate text-[11px] leading-4 text-neutral-500">
            <span className="shrink-0">{kind.label}</span>
            <span className="text-neutral-700">·</span>
            <span className="shrink-0 tabular-nums">{formatFileSize(file.size)}</span>
            <span className="text-neutral-700">·</span>
            <span className="truncate" title={new Date(file.updatedAt).toLocaleString()}>
              {bot && file.author === bot.name ? `${file.author}, ` : file.author ? `${file.author}, ` : ''}
              {agoLabel(file.updatedAt)}
            </span>
          </span>
        </span>
      </button>
      {deleting ? (
        <Loader2 size={13} className="mr-1.5 animate-spin text-neutral-500" />
      ) : confirming ? (
        <button
          type="button"
          autoFocus
          onBlur={() => setConfirming(false)}
          onClick={() => {
            setDeleting(true);
            void onDelete().finally(() => setDeleting(false));
          }}
          className="h-6 shrink-0 rounded-md bg-red-500/15 px-2 outline-none text-[11.5px] font-medium text-red-300 ring-1 ring-red-400/25 hover:bg-red-500/25"
        >
          Delete file
        </button>
      ) : (
        <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-75 focus-within:opacity-100 group-hover:opacity-100">
          <LibraryIconButton label="Open" onClick={onOpen}>
            <ExternalLink size={12} />
          </LibraryIconButton>
          <LibraryIconButton label="Delete file" danger onClick={() => setConfirming(true)}>
            <Trash2 size={12} />
          </LibraryIconButton>
        </span>
      )}
    </li>
  );
};

/** Files: documents the bots can read. Drop files anywhere on the library to add them. */
const FilesPanel: React.FC<{
  files: BotProjectFile[] | null;
  bot: DesktopBot | null;
  projectName: string;
  uploading: boolean;
  dragging: boolean;
  onBrowse: () => void;
  onOpen: (file: BotProjectFile) => void;
  onDelete: (file: BotProjectFile) => Promise<void>;
}> = ({ files, bot, projectName, uploading, dragging, onBrowse, onOpen, onDelete }) => (
  <LibraryPanel
    icon={<Paperclip size={14} />}
    title="Files"
    count={files?.length}
    description="Docs and images the bots can read."
    actions={
      <button
        type="button"
        disabled={uploading}
        onClick={onBrowse}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-neutral-300 ring-1 ring-white/[0.08] transition-colors duration-75 hover:bg-white/[0.06] hover:text-neutral-100 disabled:opacity-50"
      >
        {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} {uploading ? 'Adding…' : 'Add files'}
      </button>
    }
    overlay={
      dragging ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-[#111214]/95 ring-2 ring-inset ring-sky-400/60 backdrop-blur-[2px]">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-400/15 text-sky-300">
            <Upload size={17} />
          </span>
          <span className="text-[13px] font-medium text-neutral-100">Drop to add to {projectName}</span>
          <span className="text-[11.5px] text-neutral-500">Up to 10 MB each</span>
        </div>
      ) : null
    }
  >
    {files === null ? (
      <div className="space-y-1.5" aria-hidden>
        {[0, 1].map((index) => (
          <div key={index} className="h-12 animate-pulse rounded-lg bg-white/[0.025]" />
        ))}
      </div>
    ) : files.length === 0 && !uploading ? (
      <button
        type="button"
        onClick={onBrowse}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/[0.1] px-4 py-8 text-center transition-colors duration-75 hover:border-white/[0.18] hover:bg-white/[0.02]"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.05] text-neutral-400 ring-1 ring-white/[0.08]">
          <Upload size={15} />
        </span>
        <span className="text-[12.5px] text-neutral-300">
          Drop files here or <span className="text-neutral-100 underline decoration-white/30 underline-offset-2">browse</span>
        </span>
        <span className="text-[11.5px] text-neutral-500">Up to 10 MB each</span>
      </button>
    ) : (
      <>
        <ul className="space-y-0.5">
          {uploading && (
            <li className="flex items-center gap-3 rounded-lg px-1.5 py-1.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] ring-1 ring-white/[0.07]">
                <Loader2 size={15} className="animate-spin text-neutral-400" />
              </span>
              <span className="text-[12.5px] text-neutral-400">Uploading…</span>
            </li>
          )}
          {files.map((file) => (
            <FileRow key={file.id} file={file} bot={bot} onOpen={() => onOpen(file)} onDelete={() => onDelete(file)} />
          ))}
        </ul>
        <p className="mt-2 flex items-center gap-1.5 px-1.5 text-[11px] text-neutral-600">
          <Upload size={11} /> Drop files here to add more, up to 10 MB each.
        </p>
      </>
    )}
  </LibraryPanel>
);

/**
 * A project's library: its context notes and files, kept with the project
 * for every bot and thread in it, and where the project lives. Two columns
 * when there's room; files dropped anywhere on it are uploaded.
 */
const ProjectLibrary: React.FC<{
  target: BotProjectTarget;
  name: string;
  path: string | null;
  bot: DesktopBot | null;
  onOpenBot: (botId: string) => void;
}> = ({ target, name, path, bot, onOpenBot }) => {
  const targetKey = projectCacheKey(target);
  const [project, setProject] = useState<BotProject | null>(() => botProjectCache.get(targetKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [wide, setWide] = useState(true);
  const dragDepth = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const measure = () => setWide(element.clientWidth >= 780);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const load = useCallback(async () => {
    const generation = botCacheGeneration;
    const result = await window.orion?.getBotProject?.(target);
    if (!result || generation !== botCacheGeneration) return;
    if (!result.ok) {
      setError(result.error ?? 'Couldn’t load the project.');
      return;
    }
    botProjectCache.set(targetKey, result.project ?? null);
    setProject(result.project ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the target by its key
  }, [targetKey]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (visible()) void load();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = useCallback(
    async (input: ProjectActionInput): Promise<ProjectActionResult | undefined> => {
      setError(null);
      const result = await window.orion?.botProjectAction?.(input);
      if (result && !result.ok) setError(result.error ?? 'That didn’t work.');
      else if (result?.duplicate) setError('That’s already a note.');
      void load();
      return result;
    },
    [load]
  );

  const upload = async (input: { action: 'add_files' } | { action: 'add_file_paths'; paths: string[] }) => {
    setUploading(true);
    await act({ ...target, ...input });
    setUploading(false);
  };

  // Drops here are the library's, not the app's "drop to attach".
  const dropProps = {
    onDragEnter: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      event.stopPropagation();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setDragging(false);
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => window.orion?.getPathForFile?.(file) ?? '')
        .filter(Boolean);
      if (!paths.length) {
        setError('Couldn’t read those files.');
        return;
      }
      void upload({ action: 'add_file_paths', paths });
    },
  };

  const addNote = async (content: string) => {
    const result = await act({ ...target, action: 'add_note', content });
    return Boolean(result?.ok && !result.duplicate);
  };

  return (
    <div ref={rootRef} className="min-h-full w-full max-w-[1120px] px-5 py-5" {...dropProps}>
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-300 ring-1 ring-red-400/15">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="mt-0.5 shrink-0 text-red-300/70 hover:text-red-200">
            <X size={13} />
          </button>
        </div>
      )}
      <LibraryAbout path={path} bot={bot} onOpenBot={onOpenBot} />
      <div className={`mt-3 ${wide ? 'grid grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-start gap-3' : 'flex flex-col gap-3'}`}>
        <ContextPanel
          notes={project?.notes ?? (error ? [] : null)}
          bot={bot}
          onAdd={addNote}
          onDelete={(noteId) => void act({ ...target, action: 'delete_note', noteId })}
          fold={!wide}
        />
        <FilesPanel
          files={project?.files ?? (error ? [] : null)}
          bot={bot}
          projectName={name}
          uploading={uploading}
          dragging={dragging}
          onBrowse={() => void upload({ action: 'add_files' })}
          onOpen={(file) => void act({ ...target, action: 'open_file', name: file.name, url: file.url })}
          onDelete={async (file) => {
            await act({ ...target, action: 'delete_file', fileId: file.id, name: file.name });
          }}
        />
      </div>
    </div>
  );
};

const PersonBubble: React.FC<{ content: string; files?: { name: string; size?: number }[]; meta?: React.ReactNode }> = ({ content, files, meta }) => {
  const answer = /^> \*\*Answering:\*\* (.+)\n\n([\s\S]+)$/.exec(content);
  return (
    <div className="flex flex-col items-end gap-1">
      {files && files.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {files.map((file, index) => (
            <span key={`${file.name}-${index}`} className="inline-flex max-w-[260px] items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[12px] text-neutral-300 ring-1 ring-white/[0.08]">
              <Paperclip size={12} className="shrink-0 text-neutral-500" />
              <span className="truncate">{file.name}</span>
              {file.size ? <span className="shrink-0 text-neutral-500">{formatFileSize(file.size)}</span> : null}
            </span>
          ))}
        </div>
      )}
      {content.trim() !== '' && (
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-white/[0.08] px-3.5 py-2 text-[13.5px] leading-relaxed text-neutral-100">
        {answer ? (
          <>
            <span className="mb-1 block border-l-2 border-sky-400/50 pl-2 text-[12px] text-neutral-400">{answer[1]}</span>
            {answer[2]}
          </>
        ) : (
          content
        )}
      </div>
      )}
      {meta && <span className="pr-1 text-[11px] text-neutral-500">{meta}</span>}
    </div>
  );
};

const AssistantRow: React.FC<{ bot: DesktopBot; children: React.ReactNode }> = ({ bot, children }) => (
  <div className="flex items-start gap-2.5">
    <BotAvatar bot={bot} />
    <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-neutral-200">{children}</div>
  </div>
);

const INBOX_ICON = { routine: CalendarClock, task: ListChecks, bot: Bot } as const;

const BotMessage: React.FC<{ bot: DesktopBot; message: DesktopBotMessage }> = React.memo(({ bot, message }) => {
  if (message.role === 'assistant') {
    const via = message.authorLabel?.startsWith('via ') ? message.authorLabel : null;
    return (
      <AssistantRow bot={bot}>
        <MarkdownContent content={message.content} />
        {via && <div className="mt-1 text-[11px] text-neutral-600">{via}</div>}
      </AssistantRow>
    );
  }
  const source = botInboxSource(message.authorLabel);
  if (source === 'person') return <PersonBubble content={message.content} files={message.files} />;
  const Icon = INBOX_ICON[source];
  return (
    <div className="mx-auto w-full max-w-[92%] rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-[12.5px]">
      <div className="flex items-center gap-1.5 text-neutral-400">
        <Icon size={12} />
        <span className="truncate font-medium text-neutral-300">{message.authorLabel}</span>
        <span className="ml-auto text-[10.5px] text-neutral-600">{relativeBotTime(message.createdAt)}</span>
      </div>
      <div className="mt-1 line-clamp-4 whitespace-pre-wrap text-neutral-400">{message.content}</div>
    </div>
  );
});

/** Always open: messages queue while the bot works, like texting a person. */
const BOT_ATTACHMENTS_MAX = 10;

/** A file from the clipboard or a drop with no path on disk: saved to a temp file first (bots:saveAttachment). */
const fileToAttachment = async (file: File): Promise<BotAttachmentFile | null> => {
  const filePath = window.orion?.getPathForFile?.(file) ?? '';
  if (filePath) return { path: filePath, name: file.name || 'file', size: file.size };
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
  const extension = file.type.startsWith('image/') ? `.${file.type.slice('image/'.length).replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')}` : '';
  const result = await window.orion?.saveBotAttachment?.({ name: file.name || `pasted${extension}`, data: btoa(binary) });
  return result?.ok && result.file ? result.file : null;
};

/** Always open: messages queue while the bot works, like texting a person. Files attach by button, paste or drop. */
const BotComposer: React.FC<{ botName: string; paused: boolean; onSend: (text: string, files: BotAttachmentFile[]) => void }> = ({ botName, paused, onSend }) => {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<BotAttachmentFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);
  const add = (next: BotAttachmentFile[]) => {
    setAttachError(null);
    setFiles((current) => {
      const merged = [...current];
      for (const file of next) if (!merged.some((item) => item.path === file.path)) merged.push(file);
      if (merged.length > BOT_ATTACHMENTS_MAX) setAttachError(`Up to ${BOT_ATTACHMENTS_MAX} files per message.`);
      return merged.slice(0, BOT_ATTACHMENTS_MAX);
    });
  };
  const addFiles = async (list: FileList | File[]) => {
    const picked = await Promise.all([...list].map((file) => fileToAttachment(file).catch(() => null)));
    const ok = picked.filter((file): file is BotAttachmentFile => Boolean(file));
    if (ok.length < picked.length) setAttachError('Some files couldn’t be attached.');
    add(ok);
  };
  const pick = async () => {
    const result = await window.orion?.pickBotAttachments?.();
    if (!result) return;
    if (!result.ok) {
      setAttachError(result.error ?? 'Couldn’t attach those files.');
      return;
    }
    add(result.files ?? []);
    ref.current?.focus();
  };
  const submit = () => {
    if (!text.trim() && !files.length) return;
    onSend(text, files);
    setText('');
    setFiles([]);
    setAttachError(null);
    ref.current?.focus();
  };
  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className="mx-auto w-full max-w-[760px]">
        {paused && <div className="mb-1.5 text-center text-[11.5px] text-neutral-500">{botName} is paused: messages wait until you resume it.</div>}
        <div
          className={`rounded-2xl border bg-white/[0.035] px-3.5 py-2 transition-colors focus-within:border-white/20 ${
            dragging ? 'border-sky-400/60 bg-sky-400/[0.06]' : 'border-white/10'
          }`}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            setDragging(false);
            void addFiles(event.dataTransfer.files);
          }}
        >
          {files.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5 pt-0.5">
              {files.map((file) => (
                <span key={file.path} className="inline-flex max-w-[240px] items-center gap-1.5 rounded-lg bg-white/[0.06] py-1 pl-2.5 pr-1 text-[12px] text-neutral-200 ring-1 ring-white/[0.08]">
                  <Paperclip size={12} className="shrink-0 text-neutral-500" />
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0 text-neutral-500">{formatFileSize(file.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setFiles((current) => current.filter((item) => item.path !== file.path))}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-white/[0.08] hover:text-neutral-200"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <button
              type="button"
              aria-label="Attach files"
              title="Attach files (or paste, or drop them here)"
              onClick={() => void pick()}
              className="mb-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-white/[0.08] hover:text-neutral-100"
            >
              <Paperclip size={15} />
            </button>
            <textarea
              ref={ref}
              value={text}
              rows={1}
              placeholder={`Message ${botName}`}
              onChange={(event) => setText(event.target.value)}
              onPaste={(event) => {
                if (!event.clipboardData.files.length) return;
                event.preventDefault();
                void addFiles(event.clipboardData.files);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              className="max-h-[200px] min-h-[22px] flex-1 resize-none bg-transparent py-1 text-[13.5px] leading-relaxed text-neutral-100 outline-none placeholder:text-neutral-500"
            />
            <button
              type="button"
              aria-label="Send"
              onClick={submit}
              disabled={!text.trim() && !files.length}
              className="mb-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-900 transition-opacity disabled:opacity-25"
            >
              <ArrowUp size={14} strokeWidth={2.4} />
            </button>
          </div>
        </div>
        {attachError && <div className="mt-1 px-1 text-[11.5px] text-red-300">{attachError}</div>}
      </div>
    </div>
  );
};
