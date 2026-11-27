import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import {
  AlertCircle,
  Archive,
  ArrowDown,
  ArrowUp,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  CornerDownLeft,
  Crown,
  Ellipsis,
  Eraser,
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
  GripVertical,
  Library,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  MessagesSquare,
  NotebookPen,
  Paperclip,
  Pause,
  Pin,
  Plus,
  Reply,
  RotateCw,
  Search,
  SquarePen,
  Trash2,
  Undo2,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import { defaultDurangoBotsSettings, defaultDurangoSettings, useOrionStore, type Thread } from '../store';
import { confirmDialog } from './ConfirmDialog';
import { formatShortTime, getThreadActivityTime } from './time';
import { botFaceDataUrl, botFaceSeed } from './botFace';
import { ProjectIcon } from './ProjectIcon';
import { ProjectBadge, ProjectMonogram } from './ProjectBadge';
import { ThreadRow, type SidebarV2Actions } from './SidebarV2';
import { compareSidebarV2Recent, sidebarV2ThreadLists, threadSidebarTone } from './threadLists';
import { MarkdownContent } from './markdown';
import { CopyMessageButton } from './chat';
import { handleLightboxImageClick } from './imageLightbox';
import { localMediaSrc } from './attachments';
import { appendBotDraftFiles, botDraftKey, loadBotDraft, projectBotDraftKey, restoreUnsentBotDraft, useBotDraftSaver } from './botDrafts';
import { BotActionsRow, BotCards, BotFileGallery, threadIsHere, useMessageFiles, type BotActionHandlers } from './BotReplyCards';
import { SidebarFooter, type SidebarFooterProps } from './SidebarFooter';
import { sortProjectsByLatestThreadStart } from './projectOrder';
import { useSidebarResize } from './useSidebarResize';
import { useBotsShellSlot } from './botsShellSlot';
import { registerBotFileDropHandler } from './rootFileDrop';
import { AGENTS_SIDEBAR_STORAGE_KEY, SidebarModeHeader } from './SidebarModeHeader';
import { noteBotList } from './botsTabBadge';
import {
  BOT_THREAD_FIRST_PAGE,
  BOT_THREAD_OLDER_PAGE,
  BOT_THREAD_POLL_PAGE,
  BOT_THREAD_POLL_ROUNDS,
  botPollCursor,
  mergeBotMessages,
  useBotMessageWindow,
} from './botThreadWindow';
import {
  botInboxSource,
  botIsWorking,
  botModelLabel,
  LOCAL_BOT_PLACE,
  formatFileSize,
  newBotMessageId,
  projectBotsFor,
  relativeBotTime,
  resolveThreadStarter,
  taskReportActions,
  taskReportBody,
  type BotProject,
  type BotProjectFile,
  type BotProjectNote,
  type BotProjectTarget,
  type DesktopBot,
  type DesktopBotLive,
  type DesktopBotMessage,
  type DesktopBotThread,
  type BotAttachmentFile,
  type BotAttachmentUploadStatus,
  type BotModelChoice,
  type ThreadStarter,
} from './bots';
import { applyOptimisticBotOrder, reorderList, sortProjectBots, sortProjectGroups } from './botOrder';
import { botReplyDisplayAuthor, botReplyTarget, parseBotReplyQuote, withBotReplyQuote, type BotReplyTarget } from './botReplyQuote';
import {
  computeDropIndicatorOffset,
  computeItemDisplacement,
  handleReorderKeyDown,
  useSidebarDragReorder,
} from './useSidebarDragReorder';
import { BotModelMenu } from './BotModelMenu';
import { BotNeedsYouPanel, type UserActionHandlers } from './BotNeedsYou';
import { allBotCards, botSentAnswers, threadCardsKey, withNeedsYouNow, type BotThreadRequest } from './botThreadRequests';

// The sidebar's Bots tab (once "Sidebar v3" in Settings → Experimental): the
// sidebar lists the person's Durango bots under the shared header
// (SidebarModeHeader.tsx), and the main panel is the picked bot's
// conversation. Messages are never blocked: they queue in the bot's thread and
// a reply in progress takes them in. Data comes from Durango with this app's
// sign-in (window.orion.listBots / getBotThread / sendBotMessage), polled
// while the view is open: briskly while a bot is replying, slowly otherwise.
// Signed out of Durango, the same calls reach this device's own bots
// (src/main/local-bots.js), whose replies run on this machine's Claude Code.

const LIST_POLL_MS = 5_000;
const THREAD_POLL_ACTIVE_MS = 1_200;
const THREAD_POLL_IDLE_MS = 4_000;

type Outgoing = {
  id: string;
  content: string;
  files?: BotAttachmentFile[];
  pendingIds?: string[];
  failed?: string;
  sent?: boolean;
};

/** Thumbnails of images you sent, by message id, so the stored message keeps them (this session only). */
const SENT_PREVIEWS_MAX = 40;
const sentPreviews = new Map<string, { name: string; preview: string }[]>();
const releasePreview = (preview: string | undefined) => {
  if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview);
};
const rememberSentPreviews = (messageId: string, files: BotAttachmentFile[]) => {
  const previews = files.flatMap((file) => (file.preview ? [{ name: file.name, preview: file.preview }] : []));
  if (!previews.length) return;
  // A retry sends the same files: release only thumbnails it no longer has.
  sentPreviews.get(messageId)?.forEach((item) => previews.some((next) => next.preview === item.preview) || releasePreview(item.preview));
  sentPreviews.delete(messageId);
  sentPreviews.set(messageId, previews);
  while (sentPreviews.size > SENT_PREVIEWS_MAX) {
    const [oldest] = sentPreviews.keys();
    sentPreviews.get(oldest)?.forEach((item) => releasePreview(item.preview));
    sentPreviews.delete(oldest);
  }
};
/** A stored message's files with the thumbnails sent from here, matched by name in order. */
const withSentPreviews = (messageId: string, files: BubbleFile[] | undefined): BubbleFile[] | undefined => {
  const previews = sentPreviews.get(messageId);
  if (!files?.length || !previews?.length) return files;
  const left = [...previews];
  return files.map((file) => {
    const index = left.findIndex((item) => item.name === file.name);
    if (index < 0) return file;
    const [match] = left.splice(index, 1);
    return file.preview ? file : { ...file, preview: match.preview };
  });
};
/** What Copy puts on the clipboard: the text, then the names of the files sent with it. */
const copyText = (content: string, files?: { name: string }[]) =>
  [content.trim(), files?.length ? `Attached: ${files.map((file) => file.name).join(', ')}` : ''].filter(Boolean).join('\n\n');

// The last data the Bots view showed, kept while the app runs: switching to
// the Code tab unmounts the view, and coming back shows this at once while a
// fresh load runs in the background (instead of "Loading bots…").
type BotListCache = {
  /** Whose (BotsListResult.account). */
  account: string | null;
  bots: DesktopBot[];
  projectOrder: string[];
  projectKeys: Record<string, string>;
  allowed: boolean;
  mode: 'local' | 'durango' | null;
  cloudOnly: boolean;
  /** The recommended models a bot can be set to (null: an older Durango, no picker). */
  modelChoices: BotModelChoice[] | null;
  /** The full searchable catalog (recommended + cloud catalog + local Claude models). */
  modelCatalog: BotModelChoice[] | null;
  /** Whether Claude Code is available to answer bot replies on this machine. */
  claudeAvailable: boolean;
};
let botListCache: BotListCache | null = null;
const botThreadCache = new Map<string, DesktopBotThread>();
const botThreadEpochs = new Map<string, number>();
const botProjectCache = new Map<string, BotProject | null>();
// Bumped whenever the caches are dropped: a response to a request made
// before (for another account) is ignored.
let botCacheGeneration = 0;
const bumpBotThreadEpoch = (botId: string) => {
  const next = (botThreadEpochs.get(botId) ?? 0) + 1;
  botThreadEpochs.set(botId, next);
  return next;
};
const clearBotCaches = () => {
  botCacheGeneration += 1;
  botListCache = null;
  // Answers sent from the old account's bot chats don't apply to the next one.
  botSentAnswers.clear();
  botThreadCache.clear();
  botThreadEpochs.clear();
  botProjectCache.clear();
};
const projectCacheKey = (target: BotProjectTarget) => target.botId ?? `project:${target.projectId}`;

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
const THIS_DEVICE = isMac ? 'this Mac' : 'this computer';

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

type FaceBot = Pick<DesktopBot, 'emoji' | 'name' | 'role'> & { id?: string; project?: { key: string } | null; faceSeed?: string };

/** A bot's emoji, its project's icon when available, or its robot face (botFace.ts). */
const BotIcon: React.FC<{ bot: FaceBot; px: number; projectPath?: string | null }> = ({ bot, px, projectPath }) => {
  if (bot.emoji) return <>{bot.emoji}</>;
  const seed = bot.faceSeed ?? (bot.id ? botFaceSeed({ id: bot.id, project: bot.project }) : bot.name);
  const face = <img src={botFaceDataUrl(seed)} width={px} height={px} alt="" draggable={false} className="block" />;
  if (!projectPath) return face;
  return (
    <ProjectIcon
      projectPath={projectPath}
      size={px}
      className="block rounded-[22%] !bg-transparent object-contain"
      fallback={face}
    />
  );
};

const BotAvatar: React.FC<{ bot: FaceBot; size?: 'sm' | 'md'; projectPath?: string | null }> = ({
  bot,
  size = 'sm',
  projectPath,
}) => (
  <span
    className={`relative inline-flex shrink-0 items-center justify-center rounded-[10px] bg-white/[0.06] ring-1 ring-white/10 ${
      size === 'md' ? 'h-8 w-8 text-[16px]' : 'h-6 w-6 text-[13px]'
    }`}
    aria-hidden
  >
    <BotIcon bot={bot} px={size === 'md' ? 24 : 18} projectPath={projectPath} />
    {bot.role === 'primary' && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />}
  </span>
);

type WorkspaceProps = {
  sidebarFooterProps: SidebarFooterProps;
  /** The thread view's "Needs you" card handlers: a bot's chat answers its threads' cards with them. */
  userActionHandlers?: UserActionHandlers;
  /** The usual thread view (App's agents panel), shown when a thread is open here. */
  threadPanel: React.ReactNode;
  /** Starts a new thread in a project; returns its id. */
  onNewThread: (projectId: string) => string;
  /** Sidebar v2's thread actions and state: the project page lists threads with its rows. */
  threadActions: SidebarV2Actions;
  attentionThreadIds: ReadonlyMap<string, number>;
  paneThreadIds: string[];
};

/** A row of the projects window: a Durango Code project here, or a remote project with bots elsewhere. */
type ProjectEntry = {
  /** Store project id, or `project:<projectKey>`. */
  id: string;
  name: string;
  path: string | null;
  /** All bots belonging to this project, most recently active first. */
  bots: DesktopBot[];
  /** Convenience: the project's most recently active bot, if any. */
  bot: DesktopBot | null;
  /** The project's key (Durango repo or machine project key). */
  key: string | null;
  repoId: string | null;
  threads: Thread[];
};

/** A project group in the Bots sidebar (expandable menu of bots under a project). */
type SidebarProjectGroup = {
  /** Unique collapse key (the project key). */
  groupKey: string;
  name: string;
  /** Store project id when open on this computer, else null. */
  projectId: string | null;
  path: string | null;
  repoId: string | null;
  bots: DesktopBot[];
  latestActivityAt: number;
  earliestCreatedAt: number;
};

type SidebarDragMeta =
  | { kind: 'project'; group: SidebarProjectGroup; expanded: boolean }
  | { kind: 'bot'; bot: DesktopBot; projectKey: string; projectPath: string | null };

/** A project option selectable inside the New Bot modal. */
type NewBotProjectOption = {
  /** Store project id when open on this computer, else null. */
  projectId: string | null;
  key: string | null;
  name: string;
  path: string | null;
  repoId: string | null;
  existingNames: string[];
};

/** State for opening the Bot modal in create mode (pre-associated with a project, or projectless) or edit mode. */
type BotModalState =
  | { mode: 'create'; project: NewBotProjectOption | null }
  | { mode: 'edit'; bot: DesktopBot; projectPath: string | null; isSoleProjectBot: boolean };

/** Curated icon choices for the bot icon picker (1–2 code points each so every client renders them identically). */
const BOT_ICON_OPTIONS = [
  '🤖',
  '🧭',
  '💼',
  '📬',
  '📈',
  '🔎',
  '🗞️',
  '🛠️',
  '🎯',
  '🧠',
  '⚡',
  '🚀',
  '🎨',
  '📝',
  '🔒',
  '🧪',
  '📣',
  '💡',
  '🌐',
] as const;

const suggestProjectBotName = (projectName: string, existingNames: readonly string[]): string => {
  const base = projectName.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Project';
  const taken = new Set(existingNames.map((name) => name.replace(/\s+/g, ' ').trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1_000; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${base.slice(0, Math.max(1, 40 - suffix.length)).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
};

export const BotsWorkspace = React.memo(function BotsWorkspace({
  sidebarFooterProps,
  threadPanel,
  onNewThread,
  threadActions,
  attentionThreadIds,
  userActionHandlers,
}: WorkspaceProps) {
  const v3 = useOrionStore((state) => state.sidebarV3Settings);
  const selectedBotId = v3?.selectedBotId ?? null;
  const view = v3?.view ?? 'bot';
  const selectedProjectId = v3?.selectedProjectId ?? null;
  const setSidebarV3Settings = useOrionStore((state) => state.setSidebarV3Settings);
  const projects = useOrionStore((state) => state.projects);
  const threads = useOrionStore((state) => state.threads);
  const { sidebarRef, resizeHandle } = useSidebarResize({ storageKey: AGENTS_SIDEBAR_STORAGE_KEY, label: 'Agents sidebar' });
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const [listedBots, setBots] = useState<DesktopBot[] | null>(() => botListCache?.bots ?? null);
  // "Needs you" as it stands here now: a thread here asking makes its bot
  // stand out before Durango's next list (and signed out, where only this
  // computer knows); a card answered here clears it at once.
  const sentAnswers = useSyncExternalStore(botSentAnswers.subscribe, botSentAnswers.get);
  const cardsKey = useMemo(() => threadCardsKey(threads), [threads]);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const bots = useMemo(
    () => withNeedsYouNow(listedBots, threadsRef.current, sentAnswers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listedBots, cardsKey, sentAnswers]
  );
  const [projectOrder, setProjectOrder] = useState<string[]>(() => botListCache?.projectOrder ?? []);
  const [projectKeys, setProjectKeys] = useState<Record<string, string>>(() => botListCache?.projectKeys ?? {});
  const [modelChoices, setModelChoices] = useState<BotModelChoice[] | null>(() => botListCache?.modelChoices ?? null);
  const [modelCatalog, setModelCatalog] = useState<BotModelChoice[] | null>(() => botListCache?.modelCatalog ?? null);
  const [claudeAvailable, setClaudeAvailable] = useState<boolean>(() => botListCache?.claudeAvailable ?? true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');
  const [botModal, setBotModal] = useState<BotModalState | null>(null);
  const closeBotModal = useCallback(() => setBotModal(null), []);
  const [clearedEpochs, setClearedEpochs] = useState<Record<string, number>>({});
  // Incremented on every optimistic order edit so in-flight background polls
  // never overwrite a freshly dropped order with stale server data.
  const listEpochRef = useRef(0);
  const inFlightReordersRef = useRef(0);
  const reorderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const projectOrderRef = useRef(projectOrder);
  projectOrderRef.current = projectOrder;
  const {
    activeDrag,
    overlayElRef,
    registerItem,
    startPointerDrag,
    shouldSuppressClick,
  } = useSidebarDragReorder<SidebarDragMeta>(sidebarScrollRef);
  const activeDragRef = useRef(activeDrag);
  activeDragRef.current = activeDrag;
  const collapsedBotProjects = v3?.collapsedBotProjects ?? [];
  const collapsedSet = useMemo(() => new Set(collapsedBotProjects), [collapsedBotProjects]);
  const toggleProjectGroup = useCallback(
    (groupKey: string) => {
      const current = useOrionStore.getState().sidebarV3Settings?.collapsedBotProjects ?? [];
      const next = current.includes(groupKey) ? current.filter((key) => key !== groupKey) : [...current, groupKey];
      setSidebarV3Settings({ collapsedBotProjects: next });
    },
    [setSidebarV3Settings]
  );
  const expandProjectGroup = useCallback(
    (groupKey: string) => {
      const current = useOrionStore.getState().sidebarV3Settings?.collapsedBotProjects ?? [];
      if (!current.includes(groupKey)) return;
      setSidebarV3Settings({ collapsedBotProjects: current.filter((key) => key !== groupKey) });
    },
    [setSidebarV3Settings]
  );
  const [allowed, setAllowed] = useState(() => botListCache?.allowed ?? true);
  // Answers sent from a bot chat here are checked against every listed bot's
  // cards (whichever bot is open): forgotten once taken, failed or re-opened.
  useEffect(() => {
    botSentAnswers.reconcile(allBotCards(listedBots, threadsRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listedBots, cardsKey, sentAnswers]);
  // The Bots tab's badge reads "Needs you" as the sidebar shows it.
  useEffect(() => {
    if (allowed && bots) noteBotList(bots);
  }, [allowed, bots]);
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
    const requestEpoch = listEpochRef.current;
    const [result, modeResult] = await Promise.all([window.orion?.listBots?.(), window.orion?.getBotsMode?.().catch(() => null)]);
    const nextMode = modeResult ? modeResult.mode : botListCache?.mode ?? null;
    const nextCloudOnly = modeResult
      ? modeResult.mode === 'durango' && modeResult.claudeAvailable && modeResult.machineReplies === false
      : botListCache?.cloudOnly ?? false;
    const nextClaudeAvailable = modeResult ? modeResult.claudeAvailable : botListCache?.claudeAvailable ?? true;
    if (modeResult) {
      setMode(nextMode);
      setCloudOnly(nextCloudOnly);
      setClaudeAvailable(nextClaudeAvailable);
    }
    if (!result) return;
    if (!result.ok) {
      if (result.code === 'account_changed') return;
      noteBotList(null);
      // Signed out: nothing cached may show.
      if (result.code === 'not_signed_in') {
        clearBotCaches();
        setBots(null);
        setProjectOrder([]);
        setAccount(null);
      }
      setListError(result.code === 'not_signed_in' ? 'Sign in to Durango (Settings → Durango) to see your bots.' : result.error ?? 'Couldn’t load your bots.');
      return;
    }
    // Another account (or signed in or out) since the cache was made: the old
    // account's bots, threads and libraries go.
    const nextAccount = result.account ?? null;
    const accountSwitched = Boolean(botListCache && (botListCache.mode !== nextMode || botListCache.account !== nextAccount));
    if (accountSwitched) clearBotCaches();
    // Ignore stale poll responses that began before an optimistic reorder or while dragging (unless the account changed).
    if (!accountSwitched && (activeDragRef.current || listEpochRef.current !== requestEpoch || inFlightReordersRef.current > 0)) {
      return;
    }
    const nextBots = result.bots ?? [];
    const nextProjectOrder = Array.isArray(result.projectOrder) ? result.projectOrder : [];
    setAccount(nextAccount);
    setListError(null);
    setAllowed(result.allowed !== false);
    setBots(nextBots);
    setProjectOrder(nextProjectOrder);
    noteBotList(result.allowed === false ? null : nextBots);
    setProjectKeys(result.projectKeys ?? {});
    setModelChoices(result.modelChoices ?? null);
    setModelCatalog(result.modelCatalog ?? result.modelChoices ?? null);
    botListCache = {
      account: nextAccount,
      bots: nextBots,
      projectOrder: nextProjectOrder,
      projectKeys: result.projectKeys ?? {},
      allowed: result.allowed !== false,
      mode: nextMode,
      cloudOnly: nextCloudOnly,
      claudeAvailable: nextClaudeAvailable,
      modelChoices: result.modelChoices ?? null,
      modelCatalog: result.modelCatalog ?? result.modelChoices ?? null,
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

  // Primary bot(s) stay pinned at the top; projectless (standalone) bots sit
  // directly below them; project bots are grouped into expandable menus by project.
  const { primaryBots, standaloneBots, sidebarProjectGroups } = useMemo(() => {
    const list = bots ?? [];
    const primary = list.filter((bot) => bot.role === 'primary');
    const rest = list.filter((bot) => bot.role !== 'primary');

    // Map projectKey -> local store project (when open on this machine).
    const localByKey = new Map<string, { id: string; name: string; path: string }>();
    for (const project of projects) {
      const key = projectKeys[project.id];
      if (key && !localByKey.has(key)) localByKey.set(key, project);
    }

    const byProject = new Map<string, SidebarProjectGroup>();
    const standalone: DesktopBot[] = [];
    for (const bot of rest) {
      if (bot.project?.key) {
        const key = bot.project.key;
        const local = localByKey.get(key) ?? null;
        let group = byProject.get(key);
        if (!group) {
          group = {
            groupKey: key,
            name: local?.name ?? bot.project.name,
            projectId: local?.id ?? null,
            path: local?.path ?? null,
            repoId: bot.project.repoId ?? null,
            bots: [],
            latestActivityAt: 0,
            earliestCreatedAt: Number.MAX_SAFE_INTEGER,
          };
          byProject.set(key, group);
        }
        group.bots.push(bot);
        if (bot.lastActivityAt > group.latestActivityAt) group.latestActivityAt = bot.lastActivityAt;
        if (typeof bot.createdAt === 'number' && bot.createdAt < group.earliestCreatedAt) {
          group.earliestCreatedAt = bot.createdAt;
        }
      } else {
        standalone.push(bot);
      }
    }

    standalone.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    const groups = sortProjectGroups(
      [...byProject.values()].map((group) => ({ ...group, bots: sortProjectBots(group.bots) })),
      projectOrder
    );

    return { primaryBots: primary, standaloneBots: standalone, sidebarProjectGroups: groups };
  }, [bots, projectKeys, projectOrder, projects]);

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

  // Local project path by Durango project key, so project bots use their project's icon.
  const projectPathByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      const key = projectKeys[project.id];
      if (key && project.path) map.set(key, project.path);
    }
    return map;
  }, [projects, projectKeys]);
  const projectPathOfBot = useCallback(
    (bot: Pick<DesktopBot, 'project'> | null | undefined) =>
      bot?.project?.key ? projectPathByKey.get(bot.project.key) ?? null : null,
    [projectPathByKey]
  );
  const projectBotCountsByKey = useMemo(() => {
    const counts = new Map<string, number>();
    for (const candidate of bots ?? []) {
      const key = candidate.project?.key;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [bots]);
  const soleProjectPathOfBot = useCallback(
    (bot: Pick<DesktopBot, 'project'> | null | undefined) => {
      const key = bot?.project?.key;
      if (!key || projectBotCountsByKey.get(key) !== 1) return null;
      return projectPathByKey.get(key) ?? null;
    },
    [projectBotCountsByKey, projectPathByKey]
  );

  // The projects window: projects open here (each with all its bots), the one
  // where a thread was most recently started first, then remote projects
  // grouped by project key.
  const projectEntries = useMemo<ProjectEntry[]>(() => {
    const list = bots ?? [];
    const here: ProjectEntry[] = sortProjectsByLatestThreadStart(projects, threads).map((project) => {
      const key = projectKeys[project.id] ?? null;
      const projectBots = projectBotsFor(list, key ?? undefined);
      const repoId = projectBots.find((candidate) => candidate.project?.repoId)?.project?.repoId ?? null;
      return {
        id: project.id,
        name: project.name,
        path: project.path,
        bots: projectBots,
        bot: projectBots[0] ?? null,
        key,
        repoId,
        threads: threadsByProject.get(project.id) ?? [],
      };
    });
    const shownKeys = new Set(here.map((entry) => entry.key).filter((key): key is string => Boolean(key)));
    const remoteByKey = new Map<string, ProjectEntry>();
    for (const bot of list) {
      if (!bot.project || shownKeys.has(bot.project.key)) continue;
      const key = bot.project.key;
      let entry = remoteByKey.get(key);
      if (!entry) {
        entry = {
          id: `project:${key}`,
          name: bot.project.name,
          path: null,
          bots: [],
          bot: null,
          key,
          repoId: bot.project.repoId ?? null,
          threads: [],
        };
        remoteByKey.set(key, entry);
      }
      entry.bots.push(bot);
    }
    const elsewhere = [...remoteByKey.values()].map((entry) => {
      entry.bots = sortProjectBots(entry.bots);
      entry.bot = entry.bots[0] ?? null;
      return entry;
    });
    return [...here, ...elsewhere];
  }, [bots, projectKeys, projects, threads, threadsByProject]);

  // Every project selectable in the New Bot modal (local projects + remote projects with bots).
  const newBotProjectOptions = useMemo<NewBotProjectOption[]>(
    () =>
      projectEntries
        .filter((entry) => !entry.id.startsWith('bot:') && (!entry.id.startsWith('project:') || Boolean(entry.key)))
        .map((entry) => ({
          projectId: !entry.id.startsWith('project:') ? entry.id : null,
          key: entry.key,
          name: entry.name,
          path: entry.path,
          repoId: entry.repoId,
          existingNames: entry.bots.map((item) => item.name),
        })),
    [projectEntries]
  );

  const openBot = (botId: string) => setSidebarV3Settings({ selectedBotId: botId, view: 'bot' });
  // A thread opened from a project page shows in the usual thread view (the
  // same as Sidebar v2's: its header, theme, subagents and prompt box). Esc
  // goes back to the project, when no menu of the thread view is open.
  const threadFromProjectId = v3?.threadFromProjectId ?? null;
  const openProjectThread = (threadId: string) => {
    threadActions.selectThread(threadId);
    setSidebarV3Settings({ view: 'thread', threadFromProjectId: selectedProjectId });
  };
  // A bot reply's Open thread button: the thread in the usual thread view.
  const openBotThread = (threadId: string) => {
    if (!threadIsHere(threadId)) return false;
    threadActions.selectThread(threadId);
    setSidebarV3Settings({ view: 'thread', threadFromProjectId: null });
    return true;
  };
  const newProjectThread = (projectId: string) => {
    onNewThread(projectId);
    setSidebarV3Settings({ view: 'thread', threadFromProjectId: projectId });
  };
  useEffect(() => {
    if (view !== 'thread' || !threadFromProjectId) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector(THREAD_VIEW_OPEN_MENUS)) return;
      setSidebarV3Settings({ view: 'project', selectedProjectId: threadFromProjectId, threadFromProjectId: null });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view, threadFromProjectId, setSidebarV3Settings]);
  const openProjects = () => setSidebarV3Settings({ view: 'projects' });
  const openProject = (projectId: string) => setSidebarV3Settings({ view: 'project', selectedProjectId: projectId });
  // From a project bot's header: its project's page.
  const openProjectOfBot = (bot: DesktopBot) => {
    const entry = projectEntries.find((candidate) => (bot.project?.key && candidate.key === bot.project.key) || candidate.bots.some((item) => item.id === bot.id));
    openProject(entry?.id ?? (bot.project ? `project:${bot.project.key}` : `bot:${bot.id}`));
  };
  const botAdded = useCallback(
    (bot: DesktopBot) => {
      setBots((current) => {
        if (!current) return [bot];
        if (current.some((item) => item.id === bot.id)) return current;
        const next = [...current, bot];
        if (botListCache) botListCache = { ...botListCache, bots: next };
        noteBotList(next);
        return next;
      });
      if (bot.project?.key) expandProjectGroup(bot.project.key);
      void loadBots();
    },
    [expandProjectGroup, loadBots]
  );
  const updateBotAsked = useCallback((targetBotId: string, asked: boolean) => {
    setBots((current) => {
      if (!current) return current;
      let changed = false;
      const next = current.map((item) => {
        if (item.id !== targetBotId) return item;
        const hasPendingRequest = Boolean(item.requests?.some((req) => req.status !== 'answering'));
        const nextNeedsYou = asked || hasPendingRequest;
        if (item.asked === asked && item.needsYou === nextNeedsYou) return item;
        changed = true;
        return { ...item, asked, needsYou: nextNeedsYou };
      });
      if (!changed) return current;
      if (botListCache) botListCache = { ...botListCache, bots: next };
      return next;
    });
  }, []);

  const botsRef = useRef(bots);
  botsRef.current = bots;

  const botUpdated = useCallback(
    (updated: DesktopBot) => {
      const current = botsRef.current;
      if (current) {
        const next = current.map((item) => (item.id === updated.id ? updated : item));
        if (botListCache) botListCache = { ...botListCache, bots: next };
        noteBotList(next);
        setBots(next);
      }
      const cached = botThreadCache.get(updated.id);
      if (cached) botThreadCache.set(updated.id, { ...cached, bot: { ...cached.bot, ...updated } });
      void loadBots();
    },
    [loadBots]
  );

  const handleMakePrimaryBot = useCallback(
    async (bot: DesktopBot) => {
      const projectKey = bot.project?.key;
      if (!projectKey || bot.projectPrimary) return;
      setActionError(null);
      const current = botsRef.current;
      if (current) {
        const next = current.map((item) => {
          if (item.project?.key !== projectKey) return item;
          const updated = { ...item, projectPrimary: item.id === bot.id };
          const cached = botThreadCache.get(item.id);
          if (cached) botThreadCache.set(item.id, { ...cached, bot: { ...cached.bot, projectPrimary: updated.projectPrimary } });
          return updated;
        });
        if (botListCache) botListCache = { ...botListCache, bots: next };
        noteBotList(next);
        setBots(next);
      }
      const result = await window.orion?.setBotProjectPrimary?.({ botId: bot.id });
      if (!result?.ok) {
        setActionError(result?.error ?? 'Couldn’t make bot primary.');
        void loadBots();
        return;
      }
      void loadBots();
    },
    [loadBots]
  );

  const handleClearBot = useCallback(
    async (bot: DesktopBot) => {
      const confirmed = await confirmDialog({
        title: `Clear conversation with ${bot.name}?`,
        description: 'This removes all past conversation with this bot.',
        confirmLabel: 'Clear',
        tone: 'danger',
      });
      if (!confirmed) return;
      setActionError(null);
      const result = await window.orion?.clearBot?.({ botId: bot.id });
      if (!result?.ok) {
        setActionError(result?.error ?? 'Couldn’t clear conversation.');
        return;
      }
      const clearedBot: DesktopBot = result.bot ?? {
        ...bot,
        status: 'idle',
        replies: [],
        lastPreview: null,
        unread: 0,
        needsYou: false,
      };
      bumpBotThreadEpoch(bot.id);
      botThreadCache.set(bot.id, { bot: clearedBot, messages: [], live: [], hasMore: false });
      const current = botsRef.current;
      if (current) {
        const next = current.map((item) => (item.id === bot.id ? clearedBot : item));
        if (botListCache) botListCache = { ...botListCache, bots: next };
        noteBotList(next);
        setBots(next);
      }
      setClearedEpochs((epochs) => ({ ...epochs, [bot.id]: (epochs[bot.id] ?? 0) + 1 }));
      void loadBots();
    },
    [loadBots]
  );

  const handleDeleteBot = useCallback(
    async (bot: DesktopBot) => {
      if (bot.role === 'primary') return;
      const confirmed = await confirmDialog({
        title: `Delete ${bot.name}?`,
        description: 'This removes the bot and its conversation.',
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (!confirmed) return;
      setActionError(null);
      const result = await window.orion?.deleteBot?.({ botId: bot.id });
      if (!result?.ok) {
        setActionError(result?.error ?? 'Couldn’t delete bot.');
        return;
      }
      bumpBotThreadEpoch(bot.id);
      botThreadCache.delete(bot.id);
      botProjectCache.delete(bot.id);
      useOrionStore.getState().setBotDraft(botDraftKey(bot.id), { text: '', files: [] });
      setBotModal((current) => (current?.mode === 'edit' && current.bot.id === bot.id ? null : current));
      const current = botsRef.current ?? [];
      let next = current.filter((item) => item.id !== bot.id);
      if (bot.project?.key && bot.projectPrimary) {
        const siblings = next.filter((item) => item.project?.key === bot.project?.key);
        if (siblings.length > 0 && !siblings.some((item) => item.projectPrimary)) {
          const oldest = [...siblings].sort(
            (a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)
          )[0];
          if (oldest) {
            next = next.map((item) => (item.id === oldest.id ? { ...item, projectPrimary: true } : item));
            const cached = botThreadCache.get(oldest.id);
            if (cached) botThreadCache.set(oldest.id, { ...cached, bot: { ...cached.bot, projectPrimary: true } });
          }
        }
      }
      const fallbackId = next.find((item) => item.role === 'primary')?.id ?? next[0]?.id ?? null;
      if (botListCache) botListCache = { ...botListCache, bots: next };
      noteBotList(next);
      if (botsRef.current) setBots(next);
      if (selectedBotId === bot.id) {
        setSidebarV3Settings({ selectedBotId: fallbackId });
      }
      if (view === 'project' && (selectedProjectId === `bot:${bot.id}` || (bot.project?.key && selectedProjectId === `project:${bot.project.key}` && !next.some((item) => item.project?.key === bot.project?.key)))) {
        setSidebarV3Settings({ view: 'projects', selectedProjectId: null });
      }
      void loadBots();
    },
    [loadBots, selectedBotId, selectedProjectId, setSidebarV3Settings, view]
  );

  const persistReorder = useCallback(
    (payload: { projectOrder?: string[]; projectKey?: string; botIds?: string[] }) => {
      listEpochRef.current += 1;
      inFlightReordersRef.current += 1;
      reorderQueueRef.current = reorderQueueRef.current
        .catch(() => {})
        .then(async () => {
          try {
            const result = await window.orion?.reorderBots?.(payload);
            if (!result?.ok) {
              setActionError(result?.error ?? 'Couldn’t save sidebar order.');
              inFlightReordersRef.current = Math.max(0, inFlightReordersRef.current - 1);
              if (inFlightReordersRef.current === 0) void loadBots();
              return;
            }
            if (Array.isArray(result.projectOrder) && payload.projectOrder) {
              if (botListCache) botListCache = { ...botListCache, projectOrder: result.projectOrder };
            }
            inFlightReordersRef.current = Math.max(0, inFlightReordersRef.current - 1);
          } catch {
            setActionError('Couldn’t save sidebar order.');
            inFlightReordersRef.current = Math.max(0, inFlightReordersRef.current - 1);
            if (inFlightReordersRef.current === 0) void loadBots();
          }
        });
    },
    [loadBots]
  );

  const handleReorderProjectGroups = useCallback(
    (fromIndex: number, toIndex: number, { preserveFocusKey }: { preserveFocusKey?: string } = {}) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= sidebarProjectGroups.length || toIndex >= sidebarProjectGroups.length) {
        return;
      }
      const currentKeys = sidebarProjectGroups.map((group) => group.groupKey);
      const movedGroup = sidebarProjectGroups[fromIndex];
      const nextOrder = reorderList(currentKeys, fromIndex, toIndex);
      setActionError(null);
      setProjectOrder(nextOrder);
      if (botListCache) botListCache = { ...botListCache, projectOrder: nextOrder };
      setReorderAnnouncement(`Moved ${movedGroup.name} to position ${toIndex + 1} of ${sidebarProjectGroups.length}.`);
      persistReorder({ projectOrder: nextOrder });
      if (preserveFocusKey) {
        window.requestAnimationFrame(() => {
          const el = sidebarScrollRef.current?.querySelector<HTMLElement>(`[data-project-header-key="${CSS.escape(preserveFocusKey)}"]`);
          el?.focus();
        });
      }
    },
    [persistReorder, sidebarProjectGroups]
  );

  const handleReorderProjectBots = useCallback(
    (projectKey: string, fromIndex: number, toIndex: number, { preserveFocusBotId }: { preserveFocusBotId?: string } = {}) => {
      const group = sidebarProjectGroups.find((candidate) => candidate.groupKey === projectKey);
      if (!group || fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= group.bots.length || toIndex >= group.bots.length) {
        return;
      }
      const movedBot = group.bots[fromIndex];
      const nextBotIds = reorderList(
        group.bots.map((bot) => bot.id),
        fromIndex,
        toIndex
      );
      const current = botsRef.current ?? [];
      const nextBots = applyOptimisticBotOrder(current, projectKey, nextBotIds);
      setActionError(null);
      setBots(nextBots);
      if (botListCache) botListCache = { ...botListCache, bots: nextBots };
      noteBotList(nextBots);
      setReorderAnnouncement(`Moved ${movedBot.name} to position ${toIndex + 1} of ${group.bots.length} in ${group.name}.`);
      persistReorder({ projectKey, botIds: nextBotIds });
      if (preserveFocusBotId) {
        window.requestAnimationFrame(() => {
          const el = sidebarScrollRef.current?.querySelector<HTMLElement>(`[data-bot-row-id="${CSS.escape(preserveFocusBotId)}"]`);
          el?.focus();
        });
      }
    },
    [persistReorder, sidebarProjectGroups]
  );

  const reorderShortcutHint = isMac ? 'Option+Up/Down' : 'Alt+Up/Down';
  const isProjectDragging = activeDrag?.scope === 'projects';
  const projectDropIndicatorY =
    isProjectDragging && activeDrag ? computeDropIndicatorOffset(activeDrag.items, activeDrag.fromIndex, activeDrag.toIndex) : null;
  const projectGroupKeys = useMemo(() => sidebarProjectGroups.map((group) => group.groupKey), [sidebarProjectGroups]);

  const selectedBot = useMemo(() => (selectedBotId ? bots?.find((bot) => bot.id === selectedBotId) ?? null : null), [bots, selectedBotId]);
  const ready = !listError && allowed && bots !== null;
  const selectedEntry = view === 'project' ? projectEntries.find((entry) => entry.id === selectedProjectId) ?? null : null;
  return (
    <>
      <div className="sidebar agents-sidebar bots-font" ref={sidebarRef}>
        {/* Projects and the Threads | Bots switch: the same header as the Threads tab's. */}
        <SidebarModeHeader />
        <div className="h-2 shrink-0" aria-hidden />
        {mode === 'local' && (
          <div className="px-3.5 pb-2 text-[11px] leading-snug text-neutral-500">
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
        <div className="sidebar-content agents-sidebar-content !pt-0" ref={sidebarScrollRef}>
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {reorderAnnouncement}
          </div>
          {actionError && (
            <div className="mx-2 mb-2 flex items-start gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11.5px] leading-snug text-red-300 ring-1 ring-red-400/20">
              <span className="min-w-0 flex-1">{actionError}</span>
              <button
                type="button"
                aria-label="Dismiss error"
                onClick={() => setActionError(null)}
                className="shrink-0 rounded p-0.5 text-red-300/70 hover:bg-red-500/15 hover:text-red-200"
              >
                <X size={11} />
              </button>
            </div>
          )}
          {listError ? (
            <div className="px-3.5 py-2 text-[12.5px] leading-relaxed text-neutral-500">{listError}</div>
          ) : !allowed ? (
            <div className="px-3.5 py-2 text-[12.5px] leading-relaxed text-neutral-500">Bots are part of the Ultra plan on Durango.</div>
          ) : bots === null ? (
            <div className="flex items-center gap-2 px-3.5 py-2 text-[12.5px] text-neutral-500">
              <Loader2 size={13} className="animate-spin" /> Loading bots…
            </div>
          ) : (
            <div className="px-1.5 pb-3">
              <div className="mb-1 flex h-7 items-center justify-between px-2">
                <span className="text-[11px] font-medium tracking-[0.02em] text-neutral-500">Bots</span>
                <button
                  type="button"
                  title="New bot"
                  aria-label="New bot"
                  onClick={() => setBotModal({ mode: 'create', project: null })}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 transition-colors duration-75 hover:bg-white/[0.08] hover:text-neutral-100"
                >
                  <Plus size={14} />
                </button>
              </div>
              {(primaryBots.length > 0 || standaloneBots.length > 0) && (
                <ul className="space-y-px">
                  {primaryBots.map((bot) => (
                    <li key={bot.id}>
                      <BotRow
                        bot={bot}
                        projectPath={projectPathOfBot(bot)}
                        title={`${bot.name}: your main bot, across all projects`}
                        active={view === 'bot' && selectedBotId === bot.id}
                        onClick={() => openBot(bot.id)}
                        onEdit={() => setBotModal({ mode: 'edit', bot, projectPath: projectPathOfBot(bot), isSoleProjectBot: false })}
                        onClear={() => void handleClearBot(bot)}
                      />
                    </li>
                  ))}
                  {standaloneBots.map((bot) => (
                    <li key={bot.id}>
                      <BotRow
                        bot={bot}
                        projectPath={null}
                        title={bot.job ? `${bot.name} — ${bot.job.slice(0, 100)}` : bot.name}
                        active={view === 'bot' && selectedBotId === bot.id}
                        onClick={() => openBot(bot.id)}
                        onEdit={() => setBotModal({ mode: 'edit', bot, projectPath: null, isSoleProjectBot: false })}
                        onClear={() => void handleClearBot(bot)}
                        onDelete={() => void handleDeleteBot(bot)}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {sidebarProjectGroups.length > 0 && (
                <div
                  className={`relative ${primaryBots.length > 0 || standaloneBots.length > 0 ? 'mt-2.5' : ''}`}
                  data-testid="bots-project-groups"
                >
                  {projectDropIndicatorY !== null && (
                    <div
                      className="bots-drop-indicator"
                      data-testid="bots-project-drop-indicator"
                      style={{ transform: `translate3d(0, ${projectDropIndicatorY.toFixed(1)}px, 0)` }}
                      aria-hidden
                    />
                  )}
                  {sidebarProjectGroups.map((group, index) => {
                    const expanded = !collapsedSet.has(group.groupKey);
                    const groupUnread = group.bots.reduce((sum, bot) => sum + bot.unread, 0);
                    const groupWorking = group.bots.some((bot) => botIsWorking(bot));
                    const groupNeedsYou = group.bots.some((bot) => bot.needsYou);
                    const groupCanReorder = sidebarProjectGroups.length > 1;
                    const groupDisplacement =
                      isProjectDragging && activeDrag
                        ? computeItemDisplacement(activeDrag.items, activeDrag.fromIndex, activeDrag.toIndex, index)
                        : 0;
                    const isDraggedGroup = isProjectDragging && activeDrag?.id === group.groupKey;
                    const botScope = `bots:${group.groupKey}`;
                    const isBotDraggingGroup = activeDrag?.scope === botScope;
                    const botDropIndicatorY =
                      isBotDraggingGroup && activeDrag
                        ? computeDropIndicatorOffset(activeDrag.items, activeDrag.fromIndex, activeDrag.toIndex)
                        : null;
                    const groupBotIds = group.bots.map((bot) => bot.id);
                    return (
                      <section
                        key={group.groupKey}
                        ref={registerItem('projects', group.groupKey)}
                        data-project-group-key={group.groupKey}
                        className={`${index === 0 ? '' : 'mt-2.5'} ${isProjectDragging ? 'bots-drag-item' : ''} ${
                          isDraggedGroup ? 'bots-drag-placeholder' : ''
                        }`}
                        style={groupDisplacement ? { transform: `translate3d(0, ${groupDisplacement.toFixed(1)}px, 0)` } : undefined}
                        aria-label={group.name}
                      >
                        <div
                          className="group/proj relative flex h-7 items-center gap-1 rounded-md pr-1"
                          onPointerDown={(event) =>
                            startPointerDrag(event, {
                              scope: 'projects',
                              id: group.groupKey,
                              orderedIds: projectGroupKeys,
                              meta: { kind: 'project', group, expanded },
                              disabled: !groupCanReorder,
                              onCommit: (from, to) => handleReorderProjectGroups(from, to),
                            })
                          }
                        >
                          <button
                            type="button"
                            data-project-header-key={group.groupKey}
                            onClick={() => {
                              if (shouldSuppressClick()) return;
                              toggleProjectGroup(group.groupKey);
                            }}
                            onKeyDown={(event) =>
                              handleReorderKeyDown(event, index, sidebarProjectGroups.length, (from, to) =>
                                handleReorderProjectGroups(from, to, { preserveFocusKey: group.groupKey })
                              )
                            }
                            aria-expanded={expanded}
                            aria-roledescription={groupCanReorder ? 'sortable project group' : undefined}
                            aria-description={groupCanReorder ? `Drag or press ${reorderShortcutHint} to reorder project groups` : undefined}
                            title={groupCanReorder ? `${group.name} · drag or ${reorderShortcutHint} to reorder` : group.name}
                            className={`flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors duration-75 ${
                              !expanded && groupNeedsYou ? 'bg-amber-400/[0.09] hover:bg-amber-400/[0.13]' : 'hover:bg-white/[0.04]'
                            } ${groupCanReorder ? 'cursor-grab active:cursor-grabbing' : ''}`}
                          >
                            {groupCanReorder && (
                              <GripVertical
                                size={10}
                                className="pointer-events-none absolute -left-0.5 top-1/2 -translate-y-1/2 text-neutral-500 opacity-0 transition-opacity duration-100 group-hover/proj:opacity-60"
                                aria-hidden
                              />
                            )}
                            <ChevronRight
                              size={11}
                              className={`shrink-0 text-neutral-500 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
                              aria-hidden
                            />
                            {group.path ? (
                              <ProjectBadge project={{ name: group.name, path: group.path }} size={13} />
                            ) : (
                              <ProjectMonogram name={group.name} size={13} />
                            )}
                            <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-[0.01em] text-neutral-500 transition-colors duration-75 group-hover/proj:text-neutral-300">
                              {group.name}
                            </span>
                            {!expanded && (
                              <span className="flex shrink-0 items-center">
                                {groupNeedsYou ? (
                                  <BotNeedsYouLabel compact />
                                ) : groupUnread > 0 ? (
                                  <span className="rounded-full bg-sky-500 px-1.5 text-[10px] font-semibold leading-[16px] text-white">{groupUnread}</span>
                                ) : groupWorking ? (
                                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                                ) : (
                                  <span className="text-[10px] tabular-nums text-neutral-600">{group.bots.length}</span>
                                )}
                              </span>
                            )}
                          </button>
                          <button
                            type="button"
                            data-no-drag="true"
                            title={`New bot in ${group.name}`}
                            aria-label={`New bot in ${group.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setBotModal({
                                mode: 'create',
                                project: {
                                  projectId: group.projectId,
                                  key: group.groupKey,
                                  name: group.name,
                                  path: group.path,
                                  repoId: group.repoId,
                                  existingNames: group.bots.map((bot) => bot.name),
                                },
                              });
                            }}
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 opacity-0 transition-opacity duration-75 hover:bg-white/[0.08] hover:text-neutral-200 focus-visible:opacity-100 group-hover/proj:opacity-100"
                          >
                            <Plus size={12} />
                          </button>
                        </div>
                        {expanded && (
                          <ul
                            className="relative ml-[13px] mt-0.5 space-y-px border-l border-white/[0.06] pl-1.5"
                            data-project-bots-list={group.groupKey}
                          >
                            {botDropIndicatorY !== null && (
                              <div
                                className="bots-drop-indicator"
                                data-testid="bots-row-drop-indicator"
                                style={{ transform: `translate3d(0, ${botDropIndicatorY.toFixed(1)}px, 0)` }}
                                aria-hidden
                              />
                            )}
                            {group.bots.map((bot, botIndex) => {
                              const botCanReorder = group.bots.length > 1;
                              const botDisplacement =
                                isBotDraggingGroup && activeDrag
                                  ? computeItemDisplacement(activeDrag.items, activeDrag.fromIndex, activeDrag.toIndex, botIndex)
                                  : 0;
                              const isDraggedBot = isBotDraggingGroup && activeDrag?.id === bot.id;
                              const botProjectPath = group.bots.length === 1 ? projectPathOfBot(bot) : null;
                              return (
                                <li
                                  key={bot.id}
                                  ref={registerItem(botScope, bot.id)}
                                  className={`${isBotDraggingGroup ? 'bots-drag-item' : ''} ${
                                    isDraggedBot ? 'bots-drag-placeholder' : ''
                                  }`}
                                  style={botDisplacement ? { transform: `translate3d(0, ${botDisplacement.toFixed(1)}px, 0)` } : undefined}
                                >
                                  <BotRow
                                    bot={bot}
                                    projectPath={botProjectPath}
                                    title={
                                      bot.project
                                        ? bot.projectPrimary
                                          ? `${bot.name}: primary bot for ${bot.project.name} project${botCanReorder ? ` · drag or ${reorderShortcutHint} to reorder` : ''}`
                                          : `${bot.name}: ${bot.project.name} project${botCanReorder ? ` · drag or ${reorderShortcutHint} to reorder` : ''}`
                                        : bot.name
                                    }
                                    active={view === 'bot' && selectedBotId === bot.id}
                                    sortable={botCanReorder}
                                    reorderHint={botCanReorder ? reorderShortcutHint : undefined}
                                    onPointerDown={(event) =>
                                      startPointerDrag(event, {
                                        scope: botScope,
                                        id: bot.id,
                                        orderedIds: groupBotIds,
                                        meta: { kind: 'bot', bot, projectKey: group.groupKey, projectPath: botProjectPath },
                                        disabled: !botCanReorder,
                                        onCommit: (from, to) => handleReorderProjectBots(group.groupKey, from, to),
                                      })
                                    }
                                    onKeyDownReorder={(event) =>
                                      handleReorderKeyDown(event, botIndex, group.bots.length, (from, to) =>
                                        handleReorderProjectBots(group.groupKey, from, to, { preserveFocusBotId: bot.id })
                                      )
                                    }
                                    onClick={() => {
                                      if (shouldSuppressClick()) return;
                                      openBot(bot.id);
                                    }}
                                    onEdit={() =>
                                      setBotModal({
                                        mode: 'edit',
                                        bot,
                                        projectPath: projectPathOfBot(bot),
                                        isSoleProjectBot: group.bots.length === 1,
                                      })
                                    }
                                    onMakePrimary={!bot.projectPrimary ? () => void handleMakePrimaryBot(bot) : undefined}
                                    onClear={() => void handleClearBot(bot)}
                                    onDelete={() => void handleDeleteBot(bot)}
                                  />
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        <SidebarFooter {...sidebarFooterProps} />
        {resizeHandle}
      </div>
      {activeDrag &&
        createPortal(
          <div
            ref={overlayElRef}
            data-testid="bots-drag-overlay"
            className={`bots-drag-overlay bots-font ${
              activeDrag.meta.kind === 'project' && activeDrag.meta.expanded ? 'bots-drag-overlay-stack' : ''
            }`}
            style={{
              width: `${activeDrag.initialRect.width}px`,
              transform: `translate3d(${activeDrag.overlayPos.x.toFixed(1)}px, ${activeDrag.overlayPos.y.toFixed(1)}px, 0) scale(1.015)`,
            }}
            aria-hidden
          >
            {activeDrag.meta.kind === 'bot' ? (
              <BotDragPreview bot={activeDrag.meta.bot} projectPath={activeDrag.meta.projectPath} />
            ) : (
              <ProjectGroupDragPreview group={activeDrag.meta.group} expanded={activeDrag.meta.expanded} />
            )}
          </div>,
          document.body
        )}
      {/* Threads and the projects window are this machine's own: they show
          whether or not bots are available (signed out, another plan, offline). */}
      {view === 'thread' ? (
        threadPanel
      ) : (
        <div className="panel agents-panel bots-font">
          {view === 'projects' || (view === 'project' && !selectedEntry) ? (
            <ProjectsView entries={projectEntries} onOpen={openProject} />
          ) : view === 'project' && selectedEntry ? (
            <ProjectPage
              key={`${account ?? ''}:${selectedEntry.id}`}
              entry={selectedEntry}
              allBots={bots ?? []}
              soleProjectPathOfBot={soleProjectPathOfBot}
              onBack={openProjects}
              onOpenBot={openBot}
              onNewThread={newProjectThread}
              onOpenThread={openProjectThread}
              onBotAdded={botAdded}
              onRequestNewBot={(project) => setBotModal({ mode: 'create', project })}
              threadActions={threadActions}
              attentionThreadIds={attentionThreadIds}
              account={account}
            />
          ) : !ready ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Bot size={30} />
              </div>
              <div className="empty-state-title">Your bots</div>
              <div className="text-xs text-[#6b6b74]">{listError ?? (allowed ? 'Loading…' : 'Bots are part of the Ultra plan on Durango.')}</div>
            </div>
          ) : selectedBotId ? (
            <BotPane
              key={`${account ?? ''}:${selectedBotId}:${clearedEpochs[selectedBotId] ?? 0}`}
              botId={selectedBotId}
              botHint={selectedBot}
              projectPath={projectPathOfBot(selectedBot)}
              modelChoices={modelChoices}
              modelCatalog={modelCatalog}
              local={mode === 'local'}
              claudeAvailable={claudeAvailable}
              machineReplies={!cloudOnly}
              onChanged={loadBots}
              onAskedChange={updateBotAsked}
              onOpenProject={openProjectOfBot}
              onOpenThread={openBotThread}
              requests={selectedBot?.requests}
              userActionHandlers={userActionHandlers}
            />
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
      {botModal && (
        <BotFormModal
          state={botModal}
          projectOptions={newBotProjectOptions}
          onClose={closeBotModal}
          onSaved={(saved) => {
            const wasCreate = botModal.mode === 'create';
            setBotModal(null);
            if (wasCreate) {
              botAdded(saved);
              openBot(saved.id);
            } else {
              botUpdated(saved);
            }
          }}
        />
      )}
    </>
  );
});

const projectOptionId = (project: NewBotProjectOption): string =>
  project.projectId ? `local:${project.projectId}` : `remote:${project.key ?? project.repoId ?? project.name}`;

export const BotFormModal: React.FC<{
  state: BotModalState;
  projectOptions: NewBotProjectOption[];
  onClose: () => void;
  onSaved: (bot: DesktopBot) => void;
}> = ({ state, projectOptions, onClose, onSaved }) => {
  const editingBot = state.mode === 'edit' ? state.bot : null;
  const isEditing = editingBot !== null;
  const isPrimary = editingBot?.role === 'primary';
  const initialProject = state.mode === 'create' ? state.project : null;

  // Include initialProject in selectable options if it wasn't already in projectOptions.
  const options = useMemo(() => {
    if (!initialProject) return projectOptions;
    const targetId = projectOptionId(initialProject);
    if (projectOptions.some((item) => projectOptionId(item) === targetId)) return projectOptions;
    return [initialProject, ...projectOptions];
  }, [initialProject, projectOptions]);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() =>
    initialProject ? projectOptionId(initialProject) : null
  );
  const selectedProject = useMemo(
    () => (selectedProjectId ? options.find((item) => projectOptionId(item) === selectedProjectId) ?? null : null),
    [options, selectedProjectId]
  );
  const suggestedName = useMemo(
    () => (selectedProject ? suggestProjectBotName(selectedProject.name, selectedProject.existingNames) : ''),
    [selectedProject]
  );

  // If an existing bot uses an emoji outside the curated palette (e.g. ✨ on the primary bot),
  // include it so the current choice is visibly selected and can be restored while editing.
  const initialCustomEmoji = useMemo(() => {
    const existing = editingBot?.emoji ?? null;
    if (!existing) return null;
    return (BOT_ICON_OPTIONS as readonly string[]).includes(existing) ? null : existing;
  }, [editingBot?.emoji]);
  const iconOptions = useMemo<readonly string[]>(
    () => (initialCustomEmoji ? [initialCustomEmoji, ...BOT_ICON_OPTIONS] : BOT_ICON_OPTIONS),
    [initialCustomEmoji]
  );

  const [emoji, setEmoji] = useState<string | null>(() => editingBot?.emoji ?? null);
  const [name, setName] = useState(() => editingBot?.name ?? '');
  const [job, setJob] = useState(() => editingBot?.job ?? '');
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    if (isEditing) nameRef.current?.select();
  }, [isEditing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      if (projectMenuOpen) {
        setProjectMenuOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose, projectMenuOpen]);

  useEffect(() => {
    if (!projectMenuOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [projectMenuOpen]);

  const trimmedName = name.trim().slice(0, 40);
  const trimmedJob = job.trim().slice(0, 8_000);
  const dirty = editingBot
    ? trimmedName !== editingBot.name || emoji !== (editingBot.emoji ?? null) || trimmedJob !== (editingBot.job ?? '').trim()
    : true;
  const canSubmit = !busy && (isEditing ? trimmedName.length > 0 && dirty : Boolean(selectedProject) || trimmedName.length > 0);
  const previewName = trimmedName || (editingBot ? editingBot.name : selectedProject ? suggestedName : 'New bot');
  const previewSeed = editingBot
    ? botFaceSeed({ id: editingBot.id, project: editingBot.project })
    : selectedProject?.key ?? (trimmedName || 'new-bot');
  const previewProjectPath =
    state.mode === 'edit'
      ? state.isSoleProjectBot
        ? state.projectPath
        : null
      : selectedProject && selectedProject.existingNames.length === 0
        ? selectedProject.path
        : null;

  const modalTitle = isEditing
    ? editingBot.project
      ? `Edit bot in ${editingBot.project.name}`
      : isPrimary
        ? 'Edit primary bot'
        : 'Edit bot'
    : selectedProject
      ? `New bot in ${selectedProject.name}`
      : 'New bot';

  const modalSubtitle = isEditing
    ? isPrimary
      ? 'Your main bot, across all projects.'
      : editingBot.project
        ? `Shares ${editingBot.project.name}’s notes and files, with its own conversation.`
        : 'An always-on assistant with its own conversation and instructions.'
    : selectedProject
      ? `Shares ${selectedProject.name}’s notes and files, with its own conversation.`
      : 'An always-on assistant with its own conversation and instructions.';

  const submit = async () => {
    if (busy) return;
    if (isEditing) {
      if (!trimmedName) {
        setError('Enter a name for the bot.');
        return;
      }
      if (!dirty) {
        onClose();
        return;
      }
      setBusy(true);
      setError(null);
      const result = await window.orion?.updateBot?.({
        botId: editingBot.id,
        name: trimmedName,
        job: trimmedJob,
        emoji,
      });
      setBusy(false);
      if (!result?.ok) {
        setError(result?.error ?? 'Couldn’t save changes.');
        return;
      }
      onSaved(result.bot ?? { ...editingBot, name: result.name ?? trimmedName, job: trimmedJob, emoji });
      return;
    }
    if (!canSubmit) {
      if (!selectedProject && !trimmedName) setError('Enter a name for the bot.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = selectedProject
      ? await window.orion?.createProjectBot?.({
          ...(selectedProject.projectId ? { projectId: selectedProject.projectId } : {}),
          ...(!selectedProject.projectId && selectedProject.key
            ? { project: { key: selectedProject.key, name: selectedProject.name, repoId: selectedProject.repoId } }
            : {}),
          ...(trimmedName ? { name: trimmedName } : {}),
          ...(trimmedJob ? { job: trimmedJob } : {}),
          ...(emoji ? { emoji } : {}),
        })
      : await window.orion?.createBot?.({
          name: trimmedName,
          ...(trimmedJob ? { job: trimmedJob } : {}),
          ...(emoji ? { emoji } : {}),
        });
    setBusy(false);
    if (!result?.ok || !result.bot) {
      setError(result?.error ?? 'Couldn’t create this bot.');
      return;
    }
    onSaved(result.bot);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] bots-font"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={modalTitle}
        className="relative w-full max-w-[460px] rounded-2xl border border-white/10 bg-[#18181b] p-5 text-neutral-100 shadow-[0_24px_64px_rgb(0_0_0_/_0.65)]"
      >
        <button
          type="button"
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/[0.07] hover:text-neutral-100 disabled:opacity-40"
        >
          <X size={15} />
        </button>

        {/* Centered avatar preview */}
        <div className="flex flex-col items-center pt-1 text-center">
          <span
            className="relative inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.06] text-[28px] ring-1 ring-white/15"
            aria-hidden
          >
            <BotIcon
              bot={
                editingBot
                  ? { id: editingBot.id, emoji, name: previewName, role: editingBot.role, project: editingBot.project }
                  : { emoji, name: previewName, role: 'bot', faceSeed: previewSeed }
              }
              px={38}
              projectPath={emoji ? null : previewProjectPath}
            />
            {isPrimary && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-[#18181b]" />}
          </span>
          <h2 className="mt-2.5 text-[15px] font-semibold text-neutral-100">{modalTitle}</h2>
          <p className="mt-0.5 text-[12px] text-neutral-500">{modalSubtitle}</p>
        </div>

        <div className="mt-4 space-y-3.5">
          {/* Icon picker */}
          <div>
            <span className="mb-1.5 block text-[11.5px] font-medium text-neutral-400">Icon</span>
            <div className="grid grid-cols-10 gap-1" role="radiogroup" aria-label="Bot icon">
              <button
                type="button"
                role="radio"
                aria-checked={emoji === null}
                title="Auto icon"
                onClick={() => setEmoji(null)}
                className={`flex h-9 items-center justify-center rounded-lg transition-colors duration-75 ${
                  emoji === null
                    ? 'bg-white/[0.14] ring-1 ring-white/35'
                    : 'bg-white/[0.03] hover:bg-white/[0.08]'
                }`}
              >
                {editingBot ? (
                  <BotIcon
                    bot={{ id: editingBot.id, emoji: null, name: previewName, role: editingBot.role, project: editingBot.project }}
                    px={20}
                    projectPath={previewProjectPath}
                  />
                ) : (
                  <img
                    src={botFaceDataUrl(previewSeed)}
                    width={20}
                    height={20}
                    alt="Auto"
                    draggable={false}
                    className="block"
                  />
                )}
              </button>
              {iconOptions.map((option) => {
                const active = emoji === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={option}
                    onClick={() => setEmoji(active ? null : option)}
                    className={`flex h-9 items-center justify-center rounded-lg text-[17px] leading-none transition-colors duration-75 ${
                      active
                        ? 'bg-white/[0.14] ring-1 ring-white/35'
                        : 'bg-white/[0.03] hover:bg-white/[0.08]'
                    }`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="mb-1 block text-[11.5px] font-medium text-neutral-400" htmlFor="bot-form-name">
              Name {!isEditing && selectedProject && <span className="font-normal text-neutral-500">(optional)</span>}
            </label>
            <input
              id="bot-form-name"
              ref={nameRef}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
              maxLength={40}
              placeholder={
                isEditing
                  ? 'Bot name'
                  : selectedProject
                    ? `e.g. Frontend, Reviewer (default: ${suggestedName})`
                    : 'e.g. X Reply Scout, Job Hunter, Daily Digest'
              }
              className="h-9 w-full rounded-lg bg-white/[0.04] px-3 text-[13.5px] text-neutral-100 ring-1 ring-white/10 outline-none placeholder:text-neutral-500 focus:ring-white/25"
            />
          </div>

          {/* Project association (custom Tailwind dropdown in create mode; read-only in edit mode) */}
          {isEditing ? (
            <div>
              <span className="mb-1 block text-[11.5px] font-medium text-neutral-400">Project</span>
              <div
                aria-disabled="true"
                className="flex h-9 w-full items-center gap-2 rounded-lg bg-white/[0.025] px-3 text-[13px] text-neutral-400 ring-1 ring-white/[0.08]"
              >
                {editingBot.project ? (
                  state.projectPath ? (
                    <ProjectBadge project={{ name: editingBot.project.name, path: state.projectPath }} size={15} />
                  ) : (
                    <ProjectMonogram name={editingBot.project.name} size={15} />
                  )
                ) : (
                  <Bot size={14} className="shrink-0 text-neutral-500" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {isPrimary ? 'All projects' : editingBot.project ? editingBot.project.name : 'None (projectless)'}
                </span>
              </div>
            </div>
          ) : (
            options.length > 0 && (
              <div ref={projectMenuRef} className="relative">
                <span className="mb-1 block text-[11.5px] font-medium text-neutral-400">Project</span>
                <button
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={projectMenuOpen}
                  disabled={busy}
                  onClick={() => setProjectMenuOpen((open) => !open)}
                  className="flex h-9 w-full items-center gap-2 rounded-lg bg-white/[0.04] px-3 text-left text-[13px] text-neutral-100 ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] focus:ring-white/25 disabled:opacity-40"
                >
                  {selectedProject ? (
                    selectedProject.path ? (
                      <ProjectBadge project={{ name: selectedProject.name, path: selectedProject.path }} size={15} />
                    ) : (
                      <ProjectMonogram name={selectedProject.name} size={15} />
                    )
                  ) : (
                    <Bot size={14} className="shrink-0 text-neutral-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {selectedProject ? selectedProject.name : 'None (projectless)'}
                  </span>
                  <ChevronDown
                    size={14}
                    className={`shrink-0 text-neutral-400 transition-transform duration-150 ${projectMenuOpen ? 'rotate-180' : ''}`}
                  />
                </button>
                {projectMenuOpen && (
                  <div
                    role="listbox"
                    aria-label="Project"
                    className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-[220px] overflow-y-auto rounded-xl border border-white/10 bg-[#1f1f23] p-1 shadow-[0_16px_48px_rgb(0_0_0_/_0.65)]"
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedProjectId === null}
                      onClick={() => {
                        setSelectedProjectId(null);
                        setProjectMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                        selectedProjectId === null
                          ? 'bg-white/[0.09] text-neutral-50'
                          : 'text-neutral-300 hover:bg-white/[0.06]'
                      }`}
                    >
                      <Bot size={14} className="shrink-0 text-neutral-400" />
                      <span className="min-w-0 flex-1 truncate">None (projectless)</span>
                      {selectedProjectId === null && <Check size={13} className="shrink-0 text-neutral-200" />}
                    </button>
                    <div className="my-1 border-t border-white/[0.06]" />
                    {options.map((project) => {
                      const id = projectOptionId(project);
                      const active = selectedProjectId === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          role="option"
                          aria-selected={active}
                          onClick={() => {
                            setSelectedProjectId(id);
                            setProjectMenuOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                            active ? 'bg-white/[0.09] text-neutral-50' : 'text-neutral-300 hover:bg-white/[0.06]'
                          }`}
                        >
                          {project.path ? (
                            <ProjectBadge project={{ name: project.name, path: project.path }} size={14} />
                          ) : (
                            <ProjectMonogram name={project.name} size={14} />
                          )}
                          <span className="min-w-0 flex-1 truncate">{project.name}</span>
                          {active && <Check size={13} className="shrink-0 text-neutral-200" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )
          )}

          {/* Description / system prompt */}
          <div>
            <label className="mb-1 block text-[11.5px] font-medium text-neutral-400" htmlFor="bot-form-job">
              {isPrimary ? 'Standing instructions' : 'Description / System prompt'}{' '}
              <span className="font-normal text-neutral-500">(optional)</span>
            </label>
            <textarea
              id="bot-form-job"
              value={job}
              onChange={(event) => {
                setJob(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={4}
              maxLength={8_000}
              placeholder={
                isPrimary
                  ? 'Anything you always want your primary bot to keep in mind…'
                  : editingBot?.project
                    ? `What should this bot focus on in ${editingBot.project.name}? Leave blank for general project help.`
                    : selectedProject
                      ? `What should this bot focus on in ${selectedProject.name}? Leave blank for general project help.`
                      : 'Describe what this bot does, its role, tone, or any standing instructions…'
              }
              className="w-full resize-none rounded-lg bg-white/[0.04] px-3 py-2 text-[13px] leading-relaxed text-neutral-100 ring-1 ring-white/10 outline-none placeholder:text-neutral-500 focus:ring-white/25"
            />
          </div>

          {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300 ring-1 ring-red-400/20">{error}</div>}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="h-8 rounded-lg px-3 text-[13px] text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-neutral-100 px-3.5 text-[13px] font-medium text-neutral-900 hover:bg-white disabled:opacity-45"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : isEditing ? <Check size={13} /> : <Plus size={13} />}
            {isEditing ? (busy ? 'Saving…' : 'Save changes') : busy ? 'Creating…' : 'Create bot'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

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
          Each project can have its own bots, threads, and a library of notes and files they check on demand.
        </p>
        {entries.length === 0 ? (
          <div className="text-[13px] text-neutral-500">No projects yet. Add one from the Threads tab (Add project) or the Code tab.</div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {entries.map((entry) => {
              const latest = entry.threads[0];
              const anyWorking = entry.bots.some((candidate) => botIsWorking(candidate));
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(entry.id)}
                    className="flex w-full items-start gap-3 rounded-xl bg-white/[0.025] px-3.5 py-3 text-left ring-1 ring-white/[0.06] transition-colors duration-75 hover:bg-white/[0.05]"
                  >
                    <span className="mt-0.5">
                      {entry.bot ? (
                        <BotAvatar bot={entry.bot} size="md" projectPath={entry.path} />
                      ) : entry.key ? (
                        // The project's icon when available, else the face its bot will have.
                        <BotAvatar
                          bot={{ emoji: null, name: entry.name, role: 'bot', faceSeed: entry.key }}
                          size="md"
                          projectPath={entry.path}
                        />
                      ) : (
                        <ProjectGlyph size="md" projectPath={entry.path} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-[13.5px] font-medium text-neutral-100">{entry.name}</span>
                        {anyWorking && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />}
                      </span>
                      <span className="block truncate text-[11.5px] text-neutral-500">{entry.path ?? 'On another machine'}</span>
                      <span className="mt-1.5 block truncate text-[11.5px] text-neutral-400">
                        {entry.path ? threadCount(entry.threads.length) : entry.bots.length === 1 ? '1 bot' : `${entry.bots.length} bots`}
                        {latest ? ` · ${formatShortTime(getThreadActivityTime(latest))} ago` : ''}
                        {entry.bots.length > 1
                          ? ` · ${entry.bots.length} bots · ${relativeBotTime(entry.bots[0].lastActivityAt)}`
                          : entry.bot
                            ? ` · bot ${relativeBotTime(entry.bot.lastActivityAt)}`
                            : ' · no bots yet'}
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

const ASK_SUGGESTIONS = ['Start a thread to…', 'What changed today?', 'Settle what’s done', 'Fix the failing tests'];

/**
 * One project: its bot and a prompt box to ask it (above both tabs), then
 * Threads (status cards that filter, and the threads, each opening in a
 * modal) and Library (its context notes, files and details). Projects get a
 * bot only when the person creates it (here, or by asking their main bot).
 */
const ProjectPage: React.FC<{
  entry: ProjectEntry;
  allBots: DesktopBot[];
  soleProjectPathOfBot: (bot: Pick<DesktopBot, 'project'> | null | undefined) => string | null;
  onBack: () => void;
  onOpenBot: (botId: string) => void;
  onNewThread: (projectId: string) => void;
  onOpenThread: (threadId: string) => void;
  onBotAdded: (bot: DesktopBot) => void;
  onRequestNewBot: (project: NewBotProjectOption) => void;
  threadActions: SidebarV2Actions;
  attentionThreadIds: ReadonlyMap<string, number>;
  /** The account the Bots view shows ('local' signed out): unsent prompts are kept per account. */
  account: string | null;
}> = ({ entry, allBots, soleProjectPathOfBot, onBack, onOpenBot, onNewThread, onOpenThread, onBotAdded, onRequestNewBot, threadActions, attentionThreadIds, account }) => {
  const [selectedProjectBotId, setSelectedProjectBotId] = useState<string | null>(entry.bot?.id ?? null);
  const [createdBot, setCreatedBot] = useState<DesktopBot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ProjectTab>('threads');
  const [filter, setFilter] = useState<ThreadState | null>(null);
  const local = !entry.id.startsWith('bot:') && !entry.id.startsWith('project:');
  const projectBots = useMemo(() => {
    if (!createdBot || entry.bots.some((item) => item.id === createdBot.id)) return entry.bots;
    return [createdBot, ...entry.bots];
  }, [createdBot, entry.bots]);
  const knownBots = useMemo(() => {
    if (!createdBot || allBots.some((item) => item.id === createdBot.id)) return allBots;
    return [createdBot, ...allBots];
  }, [allBots, createdBot]);
  const bot = useMemo(
    () => (selectedProjectBotId ? projectBots.find((item) => item.id === selectedProjectBotId) ?? projectBots[0] ?? null : projectBots[0] ?? null),
    [projectBots, selectedProjectBotId]
  );
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
    if (createdBot && entry.bots.some((item) => item.id === createdBot.id)) {
      setCreatedBot(null);
    }
  }, [createdBot, entry.bots]);

  useEffect(() => {
    if (selectedProjectBotId && !projectBots.some((item) => item.id === selectedProjectBotId)) {
      setSelectedProjectBotId(projectBots[0]?.id ?? null);
    } else if (!selectedProjectBotId && projectBots[0]) {
      setSelectedProjectBotId(projectBots[0].id);
    }
  }, [projectBots, selectedProjectBotId]);

  const requestNewBot = () =>
    onRequestNewBot({
      projectId: local ? entry.id : null,
      key: entry.key,
      name: entry.name,
      path: entry.path,
      repoId: entry.repoId,
      existingNames: projectBots.map((item) => item.name),
    });

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
          {(local || entry.key) && (
            <button
              type="button"
              onClick={requestNewBot}
              className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] text-neutral-300 ring-1 ring-white/[0.08] hover:bg-white/[0.06]"
            >
              <Plus size={14} /> New bot
            </button>
          )}
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
            account={account}
            bots={projectBots}
            bot={bot}
            local={local}
            onSelectBot={setSelectedProjectBotId}
            onOpenBot={onOpenBot}
            onRequestNewBot={requestNewBot}
            onBotCreated={(created) => {
              setCreatedBot(created);
              setSelectedProjectBotId(created.id);
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
                    shown.map((thread) => {
                      const starter = resolveThreadStarter(thread, knownBots, projectBots);
                      const starterProjectPath =
                        starter.kind === 'bot' && starter.bot
                          ? starter.bot.project?.key && starter.bot.project.key === entry.key
                            ? projectBots.length === 1
                              ? entry.path
                              : null
                            : soleProjectPathOfBot(starter.bot)
                          : null;
                      return (
                        <ProjectThreadRow
                          key={thread.id}
                          thread={thread}
                          state={stateOf(thread)}
                          starter={starter}
                          starterProjectPath={starterProjectPath}
                          actions={threadActions}
                          onOpen={() => onOpenThread(thread.id)}
                        />
                      );
                    })
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
                bots={projectBots}
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
 * The project's bots and a box to ask one of them something, above both tabs.
 * With no bots yet, sending creates the first one (projects get bots only when asked).
 */
const ProjectBotBox: React.FC<{
  entry: ProjectEntry;
  account: string | null;
  bots: DesktopBot[];
  bot: DesktopBot | null;
  local: boolean;
  onSelectBot: (botId: string) => void;
  onOpenBot: (botId: string) => void;
  onRequestNewBot: () => void;
  onBotCreated: (bot: DesktopBot) => void;
  onError: (error: string | null) => void;
}> = ({ entry, account, bots, bot, local, onSelectBot, onOpenBot, onRequestNewBot, onBotCreated, onError }) => {
  const draftKey = projectBotDraftKey(account, entry.id);
  const [draft, setDraft] = useState(() => loadBotDraft(draftKey).text);
  const draftSaver = useBotDraftSaver(draftKey);
  useEffect(() => draftSaver.save(draft), [draftSaver, draft]);
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
    const sentText = draft;
    const content = sentText.trim();
    if (!content || busy) return;
    // Forget the saved copy now: leaving the page before the send finishes
    // must not bring a sent prompt back. A failed send puts it back.
    draftSaver.discard();
    const unsent = () => restoreUnsentBotDraft(draftKey, { text: sentText, files: [] });
    const target = await ensureBot();
    if (!target) {
      unsent();
      return;
    }
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
      unsent();
      onError(result?.error ?? 'Couldn’t send that.');
      return;
    }
    // Text typed while it was sending stays.
    setDraft((current) => (current === sentText ? '' : current));
    setSent(true);
  };

  const name = bot?.name ?? entry.name;
  const faceBot: FaceBot = bot ?? { emoji: null, name: entry.name, role: 'bot', faceSeed: entry.key ?? entry.id };
  const status = bot
    ? bot.needsYou
      ? <span className="text-amber-300">needs you</span>
      : botIsWorking(bot)
        ? <span className="text-sky-300">working</span>
        : <>active {relativeBotTime(bot.lastActivityAt)}</>
    : null;

  return (
    <div>
      <div className="flex items-center gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-white/[0.04] text-[28px] ring-1 ring-white/[0.07]">
          <BotIcon bot={faceBot} px={38} projectPath={bots.length <= 1 ? entry.path : null} />
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
            {bot
              ? bot.projectPrimary
                ? bots.length > 1
                  ? `Primary bot · ${bots.length} bots in ${entry.name}`
                  : 'Primary project bot'
                : bots.length > 1
                  ? `One of ${bots.length} bots in ${entry.name}`
                  : 'Project bot'
              : 'No bots yet — create a custom bot or send a message below to start one'}
            {library && (library.notes || library.files) ? ` · ${library.notes} note${library.notes === 1 ? '' : 's'}, ${library.files} file${library.files === 1 ? '' : 's'} in library` : ''}
            {status && <> · {status}</>}
          </div>
        </div>
        {(local || entry.key) && bots.length === 0 && (
          <button
            type="button"
            onClick={onRequestNewBot}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-white/[0.07] px-3.5 text-[13px] font-medium text-neutral-100 ring-1 ring-white/[0.1] transition-colors duration-75 hover:bg-white/[0.12]"
          >
            <Plus size={14} /> Create bot
          </button>
        )}
      </div>
      {bots.length > 0 && (
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          {bots.map((candidate) => {
            const active = candidate.id === bot?.id;
            const candidateWorking = botIsWorking(candidate);
            return (
              <button
                key={candidate.id}
                type="button"
                onClick={() => onSelectBot(candidate.id)}
                onDoubleClick={() => onOpenBot(candidate.id)}
                title={`Message ${candidate.name} (double-click to open conversation)`}
                className={`flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] transition-colors duration-75 ${
                  active
                    ? 'bg-white/[0.1] font-medium text-neutral-100 ring-1 ring-white/[0.16]'
                    : 'bg-white/[0.03] text-neutral-400 ring-1 ring-white/[0.06] hover:bg-white/[0.06] hover:text-neutral-200'
                }`}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[11px]" aria-hidden>
                  <BotIcon bot={candidate} px={16} projectPath={bots.length === 1 ? entry.path : null} />
                </span>
                <span className="max-w-[160px] truncate">{candidate.name}</span>
                {candidate.projectPrimary && (
                  <span className="shrink-0 rounded-full bg-amber-400/12 px-1.5 text-[10px] font-medium leading-[15px] text-amber-300/90 ring-1 ring-amber-400/20">
                    Primary
                  </span>
                )}
                {candidate.needsYou ? (
                  <BotNeedsYouLabel compact />
                ) : candidate.unread > 0 ? (
                  <span className="rounded-full bg-sky-500 px-1 text-[10px] font-semibold leading-[15px] text-white">{candidate.unread}</span>
                ) : candidateWorking ? (
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />
                ) : null}
              </button>
            );
          })}
          {(local || entry.key) && (
            <button
              type="button"
              onClick={onRequestNewBot}
              className="flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] text-neutral-400 ring-1 ring-dashed ring-white/[0.12] transition-colors duration-75 hover:bg-white/[0.05] hover:text-neutral-100"
            >
              <Plus size={12} /> New bot
            </button>
          )}
        </div>
      )}
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
  starter: ThreadStarter;
  starterProjectPath?: string | null;
  actions: SidebarV2Actions;
  onOpen: () => void;
}> = ({ thread, state, starter, starterProjectPath, actions, onOpen }) => {
  const look = THREAD_STATES[state];
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
      <span
        className="flex w-28 shrink-0 items-center gap-1.5 text-[12.5px] text-neutral-400"
        title={starter.kind === 'bot' ? `Started by ${starter.name}` : undefined}
      >
        {starter.kind === 'bot' ? (
          <>
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[11px]" aria-hidden>
              {starter.bot ? <BotIcon bot={starter.bot} px={14} projectPath={starterProjectPath} /> : <Bot size={13} />}
            </span>
            <span className="min-w-0 truncate">{starter.name}</span>
          </>
        ) : starter.kind === 'durango' ? (
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
 * Open menus and pickers of the thread view (App.tsx): Esc closes them before
 * going back from a thread to the project it was opened from.
 */
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


const ProjectGlyph: React.FC<{ size?: 'sm' | 'md'; projectPath?: string | null }> = ({ size = 'sm', projectPath }) => {
  const folder = <Folder size={size === 'md' ? 14 : 12} />;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-[10px] bg-white/[0.03] text-neutral-500 ring-1 ring-white/[0.06] ${
        size === 'md' ? 'h-8 w-8' : 'h-6 w-6'
      }`}
      aria-hidden
    >
      {projectPath ? (
        <ProjectIcon
          projectPath={projectPath}
          size={size === 'md' ? 24 : 18}
          className="block rounded-[22%] !bg-transparent object-contain"
          fallback={folder}
        />
      ) : (
        folder
      )}
    </span>
  );
};

type BotMenuAction = {
  key: string;
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
  run: () => void;
};

/** Hover `...` button and portaled dropdown menu for a sidebar bot row. */
const BotRowMenu: React.FC<{
  botName: string;
  actions: BotMenuAction[];
  onOpenChange: (open: boolean) => void;
}> = ({ botName, actions, onOpenChange }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const setMenuOpen = useCallback(
    (value: boolean) => {
      setOpen(value);
      onOpenChange(value);
    },
    [onOpenChange]
  );

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = menuRef.current?.offsetWidth ?? 168;
    const height = menuRef.current?.offsetHeight ?? 112;
    const margin = 8;
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    const below = rect.bottom + 4 + height + margin <= window.innerHeight;
    const top = below ? rect.bottom + 4 : Math.max(margin, rect.top - height - 4);
    setPosition({ top, left });
  }, [open, actions.length]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMenuOpen(false);
      }
    };
    const onDismiss = () => setMenuOpen(false);
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && triggerRef.current && target.contains(triggerRef.current)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onDismiss);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onDismiss);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, setMenuOpen]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title="Bot options"
        aria-label={`Options for ${botName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 transition-colors duration-75 hover:bg-white/[0.08] hover:text-neutral-100 ${
          open ? 'bg-white/[0.08] text-neutral-100' : ''
        }`}
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen(!open);
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Ellipsis size={14} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Options for ${botName}`}
            style={position ? { top: position.top, left: position.left } : { visibility: 'hidden', top: 0, left: 0 }}
            className="fixed z-[1100] w-[168px] animate-[sidebar-menu-in_120ms_cubic-bezier(0.22,1,0.36,1)] rounded-xl border border-white/10 bg-[rgb(24_24_27_/_0.98)] p-1 shadow-[0_16px_48px_rgb(0_0_0_/_0.5)] backdrop-blur-md"
            onClick={(event) => event.stopPropagation()}
          >
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors duration-75 ${
                  action.danger ? 'text-red-300 hover:bg-red-500/10' : 'text-neutral-200 hover:bg-white/[0.07]'
                }`}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  action.run();
                }}
              >
                <span className={`flex w-3.5 justify-center ${action.danger ? 'text-red-300' : 'text-neutral-400'}`}>{action.icon}</span>
                {action.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
};

/** Lifted floating card shown under the cursor while dragging a bot row. */
const BotDragPreview: React.FC<{ bot: DesktopBot; projectPath?: string | null }> = ({ bot, projectPath }) => {
  const working = botIsWorking(bot);
  return (
    <div className="flex h-9 w-full items-center gap-2.5 px-2 text-left">
      <span className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center text-[15px] leading-none" aria-hidden>
        <BotIcon bot={bot} px={22} projectPath={projectPath} />
        {bot.role === 'primary' && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[14.5px] ${bot.unread > 0 ? 'font-semibold text-neutral-100' : 'text-neutral-200'}`}>
        {bot.name}
      </span>
      {bot.projectPrimary && (
        <span className="shrink-0 rounded-full bg-amber-400/12 px-1.5 text-[10px] font-medium leading-[16px] text-amber-300/90 ring-1 ring-amber-400/20">
          Primary
        </span>
      )}
      {bot.needsYou ? (
        <BotNeedsYouLabel />
      ) : bot.unread > 0 ? (
        <span className="shrink-0 rounded-full bg-sky-500 px-1.5 text-[11px] font-semibold leading-[18px] text-white">{bot.unread}</span>
      ) : working ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
      ) : null}
    </div>
  );
};

/** Lifted floating card shown under the cursor while dragging a collapsed or expanded project group. */
const ProjectGroupDragPreview: React.FC<{ group: SidebarProjectGroup; expanded: boolean }> = ({ group, expanded }) => {
  const groupUnread = group.bots.reduce((sum, bot) => sum + bot.unread, 0);
  const groupWorking = group.bots.some((bot) => botIsWorking(bot));
  const groupNeedsYou = group.bots.some((bot) => bot.needsYou);
  return (
    <div className="flex h-7 w-full items-center gap-1.5 px-2 text-left">
      <ChevronRight size={11} className={`shrink-0 text-neutral-400 ${expanded ? 'rotate-90' : ''}`} aria-hidden />
      {group.path ? (
        <ProjectBadge project={{ name: group.name, path: group.path }} size={13} />
      ) : (
        <ProjectMonogram name={group.name} size={13} />
      )}
      <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium tracking-[0.01em] text-neutral-200">
        {group.name}
      </span>
      {expanded ? (
        <span className="shrink-0 rounded-full bg-white/[0.08] px-1.5 text-[10px] tabular-nums leading-[16px] text-neutral-300">
          {group.bots.length} {group.bots.length === 1 ? 'bot' : 'bots'}
        </span>
      ) : groupNeedsYou ? (
        <BotNeedsYouLabel compact />
      ) : groupUnread > 0 ? (
        <span className="shrink-0 rounded-full bg-sky-500 px-1.5 text-[10px] font-semibold leading-[16px] text-white">{groupUnread}</span>
      ) : groupWorking ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
      ) : (
        <span className="shrink-0 text-[10px] tabular-nums text-neutral-400">{group.bots.length}</span>
      )}
    </div>
  );
};

/**
 * A bot that waits on the person (it asked something, or a thread it started
 * needs them): the amber "Needs you" a thread row shows, louder than an
 * unread count or a working dot.
 */
const BotNeedsYouLabel: React.FC<{ compact?: boolean }> = ({ compact = false }) => (
  <span
    className={`inline-flex shrink-0 items-center gap-1 font-medium text-amber-300 ${compact ? 'text-[10.5px]' : 'text-[11.5px]'}`}
    aria-label="Needs you"
  >
    <MessageCircleQuestion size={compact ? 11 : 13} className="shrink-0" />
    Needs you
  </span>
);

/** A compact one-line sidebar row: icon, name, hover menu, and a "Needs you", unread count or working dot. */
const BotRow: React.FC<{
  bot: DesktopBot;
  projectPath?: string | null;
  title: string;
  active: boolean;
  sortable?: boolean;
  reorderHint?: string;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDownReorder?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onClick: () => void;
  onEdit: () => void;
  onMakePrimary?: () => void;
  onClear: () => void;
  onDelete?: () => void;
}> = ({
  bot,
  projectPath,
  title,
  active,
  sortable = false,
  reorderHint,
  onPointerDown,
  onKeyDownReorder,
  onClick,
  onEdit,
  onMakePrimary,
  onClear,
  onDelete,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const working = botIsWorking(bot);
  const actions: BotMenuAction[] = [
    { key: 'edit', label: 'Edit', icon: <SquarePen size={13} />, run: onEdit },
    ...(onMakePrimary ? [{ key: 'make-primary', label: 'Make primary', icon: <Crown size={13} />, run: onMakePrimary }] : []),
    { key: 'clear', label: 'Clear', icon: <Eraser size={13} />, run: onClear },
    ...(onDelete ? [{ key: 'delete', label: 'Delete', icon: <Trash2 size={13} />, danger: true, run: onDelete }] : []),
  ];
  return (
    <div
      role="button"
      tabIndex={0}
      data-bot-row-id={bot.id}
      onClick={onClick}
      onPointerDown={sortable && !menuOpen ? onPointerDown : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (sortable && onKeyDownReorder) {
          onKeyDownReorder(event);
          if (event.defaultPrevented) return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      title={title}
      aria-current={active ? 'true' : undefined}
      aria-roledescription={sortable ? 'sortable bot' : undefined}
      aria-description={sortable && reorderHint ? `Drag or press ${reorderHint} to reorder within this project` : undefined}
      className={`group relative flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-75 ${
        sortable ? 'cursor-pointer' : 'cursor-pointer'
      } ${
        bot.needsYou
          ? `bg-amber-400/[0.09] hover:bg-amber-400/[0.13] ${active ? 'ring-1 ring-inset ring-white/[0.12]' : ''}`
          : active
            ? 'bg-white/[0.08]'
            : menuOpen
              ? 'bg-white/[0.06]'
              : 'hover:bg-white/[0.045]'
      }`}
    >
      {sortable && (
        <GripVertical
          size={9}
          className="pointer-events-none absolute -left-1 top-1/2 -translate-y-1/2 text-neutral-500 opacity-0 transition-opacity duration-100 group-hover:opacity-55"
          aria-hidden
        />
      )}
      <span className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center text-[15px] leading-none" aria-hidden>
        <BotIcon bot={bot} px={22} projectPath={projectPath} />
        {bot.role === 'primary' && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[14.5px] ${bot.unread > 0 ? 'font-semibold text-neutral-100' : 'text-neutral-300'}`}>
        {bot.name}
      </span>
      {bot.projectPrimary && (
        <span className="shrink-0 rounded-full bg-amber-400/12 px-1.5 text-[10px] font-medium leading-[16px] text-amber-300/90 ring-1 ring-amber-400/20">
          Primary
        </span>
      )}
      <span className={`shrink-0 items-center ${menuOpen ? 'hidden' : 'flex group-hover:hidden group-focus-within:hidden'}`}>
        {bot.needsYou ? (
          <BotNeedsYouLabel />
        ) : bot.unread > 0 ? (
          <span className="rounded-full bg-sky-500 px-1.5 text-[11px] font-semibold leading-[18px] text-white">{bot.unread}</span>
        ) : working ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
        ) : bot.paused ? (
          <Pause size={11} className="text-neutral-600" />
        ) : null}
      </span>
      <span
        data-no-drag="true"
        className={`-mr-0.5 shrink-0 items-center ${menuOpen ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'}`}
        onClick={(event) => event.stopPropagation()}
      >
        <BotRowMenu botName={bot.name} actions={actions} onOpenChange={setMenuOpen} />
      </span>
    </div>
  );
};

/** One bot's conversation: messages, live replies at the bottom, and a composer that never blocks. */
/** The message each bot's next message replies to (Reply on a message), while the app runs. */
const botReplyTargets = new Map<string, BotReplyTarget>();

const BotPane: React.FC<{
  botId: string;
  /** Latest profile fields from the sidebar list so edits show in the header at once. */
  botHint?: Pick<DesktopBot, 'name' | 'emoji' | 'job' | 'projectPrimary'> | null;
  /** Local project path for a project bot so its icon uses the project's icon when available. */
  projectPath?: string | null;
  /** The recommended models the bot can be set to (null: no picker). */
  modelChoices: BotModelChoice[] | null;
  /** Full searchable catalog (recommended + cloud catalog + local Claude models). */
  modelCatalog: BotModelChoice[] | null;
  /** The bots are this computer's own (signed out). */
  local: boolean;
  /** Whether Claude Code is available on this machine. */
  claudeAvailable: boolean;
  /** Whether this machine is configured to answer bots locally. */
  machineReplies: boolean;
  onChanged: () => void;
  onAskedChange: (botId: string, asked: boolean) => void;
  onOpenProject: (bot: DesktopBot) => void;
  /** Opens a Durango Code thread here in the usual thread view; false when it isn't on this computer. */
  onOpenThread: (threadId: string) => boolean;
  /** What the threads it started wait on the person for (Durango's list). */
  requests?: BotThreadRequest[];
  userActionHandlers?: UserActionHandlers;
}> = ({
  botId,
  botHint,
  projectPath,
  modelChoices,
  modelCatalog,
  local,
  claudeAvailable,
  machineReplies,
  onChanged,
  onAskedChange,
  onOpenProject,
  onOpenThread,
  requests,
  userActionHandlers,
}) => {
  // `thread.messages`: every message loaded so far (the newest page, older
  // pages scrolled back to, and what polls brought), in seq order; unchanged
  // messages keep their objects so their rows don't redraw (botThreadWindow.ts).
  const [thread, setThreadState] = useState<DesktopBotThread | null>(() => botThreadCache.get(botId) ?? null);
  const shellSlot = useBotsShellSlot();
  const [error, setError] = useState<string | null>(null);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const [uploadStatuses, setUploadStatuses] = useState<ReadonlyMap<string, BotAttachmentUploadStatus>>(() => new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const working = thread ? botIsWorking(thread.bot) : false;
  const hasUploadingAttachment = useMemo(() => {
    for (const item of uploadStatuses.values()) if (item.status === 'uploading') return true;
    return Boolean(thread?.messages.some((message) => message.files?.some((file) => file.status === 'uploading')));
  }, [uploadStatuses, thread?.messages]);
  const sending = outgoing.some((message) => !message.failed) || hasUploadingAttachment;
  const threadRef = useRef(thread);
  const mountedRef = useRef(true);
  const mountEpochRef = useRef(botThreadEpochs.get(botId) ?? 0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const setThread = useCallback(
    (update: (current: DesktopBotThread | null) => DesktopBotThread | null) => {
      if (!mountedRef.current || (botThreadEpochs.get(botId) ?? 0) !== mountEpochRef.current) return;
      const next = update(threadRef.current);
      if (next === threadRef.current) return;
      threadRef.current = next;
      if (next) botThreadCache.set(botId, next);
      setThreadState(next);
    },
    [botId]
  );

  /** A page from Durango (or this device's bots); null when it failed (the error is shown if nothing is). */
  const fetchPage = useCallback(
    async (page: { limit: number; beforeSeq?: number; afterSeq?: number }) => {
      const generation = botCacheGeneration;
      const epoch = botThreadEpochs.get(botId) ?? 0;
      const result = await window.orion?.getBotThread?.({ botId, read: visible(), ...page });
      if (!result || !mountedRef.current || generation !== botCacheGeneration || epoch !== (botThreadEpochs.get(botId) ?? 0)) return null;
      if (!result.ok || !result.bot) {
        setError(result.error ?? 'Couldn’t load this bot.');
        return null;
      }
      setError(null);
      return result as DesktopBotThread & { hasNewer?: boolean };
    },
    [botId]
  );

  const botHintName = botHint?.name;
  const botHintEmoji = botHint?.emoji;
  const botHintJob = botHint?.job;
  const botHintProjectPrimary = botHint?.projectPrimary;
  useEffect(() => {
    if (!botHintName) return;
    setThread((current) => {
      if (!current) return current;
      const nextEmoji = botHintEmoji ?? null;
      const nextJob = botHintJob ?? current.bot.job;
      const nextProjectPrimary = botHintProjectPrimary !== undefined ? botHintProjectPrimary : current.bot.projectPrimary;
      if (
        current.bot.name === botHintName &&
        current.bot.emoji === nextEmoji &&
        current.bot.job === nextJob &&
        current.bot.projectPrimary === nextProjectPrimary
      ) {
        return current;
      }
      return { ...current, bot: { ...current.bot, name: botHintName, emoji: nextEmoji, job: nextJob, projectPrimary: nextProjectPrimary } };
    });
  }, [botHintName, botHintEmoji, botHintJob, botHintProjectPrimary, setThread]);

  /** The newest page, replacing what was loaded (opening the thread, or catching up after a long gap). */
  const loadNewest = useCallback(async () => {
    const result = await fetchPage({ limit: BOT_THREAD_FIRST_PAGE });
    if (result) setThread(() => ({ bot: result.bot, live: result.live ?? [], messages: result.messages ?? [], hasMore: result.hasMore === true }));
  }, [fetchPage, setThread]);

  /**
   * What changed since the last load: the bot, its live replies, and only the
   * messages after the cursor (botPollCursor). Nothing new: nothing redraws.
   */
  const poll = useCallback(async () => {
    const shown = threadRef.current;
    let cursor = shown ? botPollCursor(shown.messages, shown.live) : null;
    if (cursor === null) {
      await loadNewest();
      return;
    }
    for (let round = 0; round < BOT_THREAD_POLL_ROUNDS; round += 1) {
      const result = await fetchPage({ limit: BOT_THREAD_POLL_PAGE, afterSeq: cursor });
      if (!result) return;
      // Conversation was cleared elsewhere (threadId rotated): reload from scratch.
      if (result.bot.threadId && shown?.bot.threadId && result.bot.threadId !== shown.bot.threadId) {
        await loadNewest();
        return;
      }
      setThread((current) => {
        if (!current) return current;
        const messages = mergeBotMessages(current.messages, result.messages);
        const live = result.live ?? [];
        const same = messages === current.messages && JSON.stringify([current.bot, current.live]) === JSON.stringify([result.bot, live]);
        return same ? current : { ...current, bot: result.bot, live, messages };
      });
      // Durango without cursors (older) sends the newest page: merged above, done.
      if (result.hasNewer !== true || !result.messages?.length) return;
      cursor = result.messages[result.messages.length - 1].seq;
    }
    // Far behind (away a long time): start again from the newest page.
    await loadNewest();
  }, [fetchPage, loadNewest, setThread]);

  /** The page before the oldest loaded message (scrolling back). → whether it loaded. */
  const loadOlder = useCallback(async () => {
    const oldest = threadRef.current?.messages[0];
    if (!oldest) return false;
    const result = await fetchPage({ limit: BOT_THREAD_OLDER_PAGE, beforeSeq: oldest.seq });
    if (!result) return false;
    const older = (result.messages ?? []).filter((message) => message.seq < oldest.seq);
    setThread((current) =>
      current
        ? {
            ...current,
            messages: mergeBotMessages(current.messages, older),
            // Durango without cursors sends the newest page again: nothing older to show.
            hasMore: older.length > 0 && result.hasMore === true,
          }
        : current
    );
    return older.length > 0;
  }, [fetchPage, setThread]);

  // Opening: what is new since the cached copy, or the newest page.
  useEffect(() => {
    void poll();
  }, [poll]);

  // Live background attachment upload state from main (survives tab switches,
  // updates the message's attachment badge immediately without waiting on polls).
  useEffect(() => {
    let active = true;
    void window.orion?.getBotAttachmentStatuses?.({ botId }).then((result) => {
      if (!active || !result?.ok || !result.items?.length) return;
      setUploadStatuses((current) => {
        const next = new Map(current);
        for (const item of result.items ?? []) next.set(item.pendingId, item);
        return next;
      });
    });
    const unsubscribe = window.orion?.onBotAttachmentStatus?.((status) => {
      if (!active || status.botId !== botId) return;
      setUploadStatuses((current) => {
        const next = new Map(current);
        next.set(status.pendingId, status);
        return next;
      });
      if (status.status === 'ready' || status.status === 'failed' || status.status === 'uploading') {
        setThread((current) => {
          if (!current) return current;
          let changed = false;
          const messages = current.messages.map((message) => {
            if (message.id !== status.messageId || !message.files?.length) return message;
            let rowChanged = false;
            const nextFiles = message.files.map((file) => {
              if (file.pendingId !== status.pendingId) return file;
              const nextStatus = status.status === 'ready' ? undefined : status.status;
              const nextAssetId = status.assetId ?? file.assetId;
              const nextError = status.status === 'failed' ? status.error : undefined;
              if (file.status === nextStatus && file.assetId === nextAssetId && file.error === nextError) return file;
              rowChanged = true;
              return {
                ...file,
                ...(nextAssetId ? { assetId: nextAssetId } : {}),
                ...(nextStatus ? { status: nextStatus } : { status: undefined }),
                ...(nextError ? { error: nextError } : { error: undefined }),
              };
            });
            if (!rowChanged) return message;
            changed = true;
            return { ...message, files: nextFiles };
          });
          return changed ? { ...current, messages } : current;
        });
      }
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [botId, setThread]);

  const retryAttachment = useCallback(
    async (messageId: string, pendingId: string) => {
      setUploadStatuses((current) => {
        const existing = current.get(pendingId);
        if (!existing) return current;
        const next = new Map(current);
        next.set(pendingId, { ...existing, status: 'uploading', error: undefined, canRetry: false });
        return next;
      });
      const result = await window.orion?.retryBotAttachmentUpload?.({ botId, messageId, pendingId });
      if (!result?.ok) {
        const errorMessage = result?.error ?? 'Couldn’t retry upload.';
        setUploadStatuses((current) => {
          const existing = current.get(pendingId);
          if (!existing) return current;
          const next = new Map(current);
          next.set(pendingId, { ...existing, status: 'failed', error: errorMessage, canRetry: true });
          return next;
        });
      }
    },
    [botId]
  );

  // Brisk while a reply is being written (or just sent), slow otherwise.
  // A poll that finds nothing new keeps the same thread object, so this
  // timer is set again by `tick` itself rather than by a redraw.
  const workingRef = useRef(false);
  workingRef.current = working || sending;
  useEffect(() => {
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      if (visible()) await poll().catch(() => {});
      if (!stopped) timer = window.setTimeout(tick, workingRef.current ? THREAD_POLL_ACTIVE_MS : THREAD_POLL_IDLE_MS);
    };
    timer = window.setTimeout(tick, working || sending ? THREAD_POLL_ACTIVE_MS : THREAD_POLL_IDLE_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [poll, working, sending]);

  const messageIds = useMemo(() => thread?.messages.map((message) => message.id) ?? [], [thread?.messages]);
  const stored = useMemo(() => new Set(messageIds), [messageIds]);
  const { range, onScroll: onWindowScroll, toLatest, settle, reveal, loadingOlder } = useBotMessageWindow({
    ids: messageIds,
    scrollRef,
    hasMore: thread?.hasMore === true,
    loadOlder,
    resetKey: botId,
  });
  // The avatar's fields only: message rows don't redraw on every status change.
  const faceKey = thread ? `${thread.bot.id}|${thread.bot.name}|${thread.bot.emoji}|${thread.bot.role}|${thread.bot.project?.key ?? ''}` : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps -- by its face fields
  const face = useMemo(() => thread?.bot ?? null, [faceKey]);
  const pending = outgoing.filter((message) => !stored.has(message.id));

  // The message the next one replies to (Reply on a message): kept per bot while the app runs.
  const [replyTarget, setReplyTargetState] = useState<BotReplyTarget | null>(() => botReplyTargets.get(botId) ?? null);
  const setReplyTarget = useCallback(
    (target: BotReplyTarget | null) => {
      if (target) botReplyTargets.set(botId, target);
      else botReplyTargets.delete(botId);
      setReplyTargetState(target);
    },
    [botId]
  );
  const botNameRef = useRef(thread?.bot.name ?? botHint?.name ?? 'Bot');
  botNameRef.current = thread?.bot.name ?? botHint?.name ?? botNameRef.current;
  const replyToMessage = useCallback(
    (message: DesktopBotMessage) => setReplyTarget(botReplyTarget(message, botNameRef.current)),
    [setReplyTarget]
  );

  // A reply quote clicked: the message it answers, scrolled into view and
  // briefly highlighted (older pages are loaded until it is found).
  const [jumpTarget, setJumpTarget] = useState<{ id: string; at: number } | null>(null);
  const jumpingRef = useRef(false);
  const jumpTo = useCallback(
    async (seq: number) => {
      if (jumpingRef.current) return;
      jumpingRef.current = true;
      try {
        for (let page = 0; page < 20; page += 1) {
          const found = threadRef.current?.messages.find((message) => message.seq === seq);
          if (found) {
            stick.current = false;
            if (reveal(found.id)) setJumpTarget({ id: found.id, at: Date.now() });
            return;
          }
          const oldest = threadRef.current?.messages[0];
          if (!oldest || oldest.seq < seq || threadRef.current?.hasMore !== true) return;
          if (!(await loadOlder())) return;
        }
      } finally {
        jumpingRef.current = false;
      }
    },
    [loadOlder, reveal]
  );
  const jumpToMessage = useCallback((seq: number) => void jumpTo(seq), [jumpTo]);
  useLayoutEffect(() => {
    if (!jumpTarget) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-bot-row="${CSS.escape(jumpTarget.id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('bot-row-flash');
    // Restart the highlight's animation when the same message is jumped to again.
    void row.offsetWidth;
    row.classList.add('bot-row-flash');
    const timer = window.setTimeout(() => row.classList.remove('bot-row-flash'), 1600);
    return () => window.clearTimeout(timer);
  }, [jumpTarget, range.start, range.end]);

  const send = useCallback(
    async (text: string, files: BotAttachmentFile[] = [], id = newBotMessageId(), replyTo: BotReplyTarget | null = null) => {
      const typed = text.trim();
      if (!typed && !files.length) return;
      // A reply carries the message it answers as a quote line in front (botReplyQuote.ts).
      const content = replyTo ? withBotReplyQuote(typed, replyTo) : typed;
      stick.current = true;
      toLatest();
      rememberSentPreviews(id, files);
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
        // Paths only: thumbnails stay in this window.
        ...(files.length ? { files: files.map(({ path, name, size }) => ({ path, name, size })) } : {}),
        ...(timeZone ? { timeZone } : {}),
      });
      if (!result?.ok) {
        setOutgoing((current) => current.map((message) => (message.id === id ? { ...message, failed: result?.error ?? 'Couldn’t send.' } : message)));
        return;
      }
      const pendingAttachments = result.pendingAttachments ?? [];
      if (pendingAttachments.length) {
        setUploadStatuses((current) => {
          const next = new Map(current);
          for (const item of pendingAttachments) {
            if (!next.has(item.pendingId)) next.set(item.pendingId, item);
          }
          return next;
        });
      }
      // Stored: it stops saying "Sending…" now, before the thread reloads.
      const pendingIds = pendingAttachments.map((item) => item.pendingId);
      setOutgoing((current) =>
        current.map((message) => (message.id === id ? { ...message, sent: true, ...(pendingIds.length ? { pendingIds } : {}) } : message))
      );
      void poll();
      onChanged();
    },
    [botId, poll, onChanged, toLatest]
  );

  const dismissAsk = useCallback(
    async (target: { messageId?: string; partId?: string; question: string }): Promise<boolean> => {
      const previous = threadRef.current;
      const previousAsked = previous?.bot.asked ?? previous?.bot.needsYou ?? false;
      const normalizedTarget = target.question.replace(/\s+/g, ' ').trim();
      const matchesCard = (card: { id: string; component: string; props: unknown }) => {
        if (card.component !== 'bot-ask') return false;
        if (target.partId) return card.id === target.partId;
        const props = (card.props && typeof card.props === 'object' ? card.props : {}) as Record<string, unknown>;
        return typeof props.question === 'string' && props.question.replace(/\s+/g, ' ').trim() === normalizedTarget;
      };
      let optimisticAsked = false;
      if (previous) {
        const patchedMessages = previous.messages.map((message) => {
          if (target.messageId && message.id !== target.messageId) return message;
          if (!message.cards?.some(matchesCard)) return message;
          return {
            ...message,
            cards: message.cards.map((card) => {
              if (!matchesCard(card)) return card;
              const props = (card.props && typeof card.props === 'object' ? card.props : {}) as Record<string, unknown>;
              return { ...card, props: { ...props, dismissed: true, dismissedAt: Date.now() } };
            }),
          };
        });
        for (let index = patchedMessages.length - 1; index >= 0; index -= 1) {
          const message = patchedMessages[index];
          if (message.role === 'user' && botInboxSource(message.authorLabel) === 'person') break;
          if (message.role !== 'assistant' || !message.cards?.length) continue;
          if (
            message.cards.some((card) => {
              if (card.component !== 'bot-ask') return false;
              const props = (card.props && typeof card.props === 'object' ? card.props : {}) as Record<string, unknown>;
              return props.dismissed !== true;
            })
          ) {
            optimisticAsked = true;
            break;
          }
        }
        const hasPendingRequest = Boolean((requests ?? previous.bot.requests)?.some((req) => req.status !== 'answering'));
        setThread(() => ({
          ...previous,
          messages: patchedMessages,
          bot: { ...previous.bot, asked: optimisticAsked, needsYou: optimisticAsked || hasPendingRequest },
        }));
      }
      onAskedChange(botId, optimisticAsked);
      const result = await window.orion
        ?.dismissBotAsk?.({
          botId,
          ...(target.messageId ? { messageId: target.messageId } : {}),
          ...(target.partId ? { partId: target.partId } : {}),
          question: target.question,
        })
        .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
      if (!result?.ok) {
        if (previous) setThread(() => previous);
        onAskedChange(botId, previousAsked);
        toast.error(result?.error ?? 'Couldn’t dismiss the question.');
        return false;
      }
      if (typeof result.needsYou === 'boolean' && result.needsYou !== optimisticAsked) {
        const finalAsked = result.needsYou;
        onAskedChange(botId, finalAsked);
        setThread((current) => {
          if (!current) return current;
          const hasPendingRequest = Boolean((requests ?? current.bot.requests)?.some((req) => req.status !== 'answering'));
          return { ...current, bot: { ...current.bot, asked: finalAsked, needsYou: finalAsked || hasPendingRequest } };
        });
      }
      onChanged();
      return true;
    },
    [botId, onAskedChange, onChanged, requests, setThread]
  );

  // What reply cards do: a button or an answer sends text as the person's message; Open thread opens it here.
  const sendRef = useRef(send);
  sendRef.current = send;
  const openThreadRef = useRef(onOpenThread);
  openThreadRef.current = onOpenThread;
  const dismissAskRef = useRef(dismissAsk);
  dismissAskRef.current = dismissAsk;
  const handlers = useMemo<BotActionHandlers>(
    () => ({
      onReply: (text) => void sendRef.current(text),
      onOpenThread: (threadId) => openThreadRef.current(threadId),
      onDismissAsk: (target) => dismissAskRef.current(target),
    }),
    []
  );
  // Questions (ask_user cards) the person answered in this thread: question → answer.
  // The same Map while its answers don't change, so memoized rows don't redraw on every new message.
  const answeredRef = useRef<{ key: string; map: Map<string, string> }>({ key: '', map: new Map() });
  const answeredQuestions = useMemo(() => {
    const answered = new Map<string, string>();
    for (const message of thread?.messages ?? []) {
      const match = message.role === 'user' ? /^> \*\*Answering:\*\* (.+)\n\n([\s\S]+)$/.exec(message.content) : null;
      if (match) answered.set(match[1].trim(), match[2].trim());
    }
    const key = JSON.stringify([...answered]);
    if (key !== answeredRef.current.key) answeredRef.current = { key, map: answered };
    return answeredRef.current.map;
  }, [thread?.messages]);

  /** The person picks the bot's reply model and/or reasoning effort: saved, then shown at once (the next poll confirms it). → an error, or null. */
  const pickModel = useCallback(
    async ({ model, reasoningEffort }: { model?: string; reasoningEffort?: string | null }) => {
      const result = await window.orion?.setBotModel?.({ botId, ...(model ? { model } : {}), ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) });
      if (!result?.ok) return result?.error ?? 'Couldn’t update the bot. Try again.';
      setThread((current) => {
        if (!current) return current;
        const nextModel = result.bot?.model ?? (model ? result.model ?? model : current.bot.model);
        const nextEffort =
          result.bot?.reasoningEffort !== undefined
            ? result.bot.reasoningEffort
            : result.reasoningEffort !== undefined
              ? result.reasoningEffort
              : reasoningEffort !== undefined
                ? reasoningEffort
                : current.bot.reasoningEffort;
        return { ...current, bot: { ...current.bot, model: nextModel, reasoningEffort: nextEffort } };
      });
      onChanged();
      return null;
    },
    [botId, onChanged, setThread]
  );

  const liveKey = thread?.live.map((reply) => `${reply.messageId}:${reply.content.length}`).join() ?? '';
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stick.current && range.following) element.scrollTop = element.scrollHeight;
  }, [thread?.messages.length, pending.length, liveKey, range.following]);

  if (!thread) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-neutral-500">
        {error ?? <Loader2 size={16} className="animate-spin" />}
      </div>
    );
  }
  const { bot } = thread;
  const rowBot = face ?? bot;
  const live = thread.live.filter((reply) => !stored.has(reply.messageId));
  // A reply that has shown text has its place: messages sent after that go below it, here and once stored.
  const placed = live.filter((reply): reply is DesktopBotLive & { seq: number } => typeof reply.seq === 'number');
  const unplaced = live.filter((reply) => typeof reply.seq !== 'number');
  // Only the mounted window (useBotMessageWindow); live replies placed inside it, or below it while following.
  const shown = thread.messages.slice(range.start, range.end);
  const fromSeq = range.start > 0 && shown.length ? shown[0].seq : -Infinity;
  const toSeq = range.following || !shown.length ? Infinity : shown[shown.length - 1].seq;
  const timeline: ({ kind: 'message'; seq: number; message: DesktopBotMessage } | { kind: 'live'; seq: number; reply: DesktopBotLive })[] = [
    ...shown.map((message) => ({ kind: 'message' as const, seq: message.seq, message })),
    ...placed.filter((reply) => reply.seq > fromSeq && reply.seq <= toSeq).map((reply) => ({ kind: 'live' as const, seq: reply.seq, reply })),
  ].sort((a, b) => a.seq - b.seq);
  const olderAbove = range.start > 0 || thread.hasMore;
  const starting = !bot.paused && live.length === 0 && (working || pending.some((message) => message.sent));
  const liveRow = (reply: DesktopBotLive) => (
    <AssistantRow key={`live-${reply.messageId}`} bot={bot} projectPath={projectPath}>
      {reply.content ? <MarkdownContent content={reply.content} refLinks /> : null}
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
  );
  // The bot's name and status: in the shell bar's title spot (where "Bots" was),
  // or as a row atop the pane when that spot isn't on screen.
  const header = (
    <>
      <BotAvatar bot={bot} size="md" projectPath={projectPath} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-[var(--text-primary)]">{bot.name}</span>
          {bot.role === 'primary' && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">all projects</span>}
          {bot.projectPrimary && (
            <span className="shrink-0 rounded-full bg-amber-400/12 px-1.5 text-[10.5px] font-medium leading-[17px] text-amber-300/90 ring-1 ring-amber-400/20">
              Primary
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
          {bot.paused ? <Pause size={11} /> : working ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> : null}
          {bot.paused ? 'Paused' : working ? (live.length > 1 ? `Working on ${live.length} replies…` : 'Working…') : bot.needsYou ? 'Waiting on you' : modelChoices?.length ? null : botModelLabel(bot.model, modelChoices)}
        </div>
      </div>
      {bot.project && (
        <button
          type="button"
          onClick={() => onOpenProject(bot)}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-[var(--text-secondary)] transition-colors duration-75 [-webkit-app-region:no-drag] hover:bg-white/[0.06] hover:text-[var(--text-primary)]"
          title="The project: its threads, notes and files"
        >
          <FolderOpen size={13} /> {bot.project.name}
        </button>
      )}
      {modelChoices?.length ? (
        <BotModelMenu
          model={bot.model}
          reasoningEffort={bot.reasoningEffort}
          choices={modelChoices}
          catalog={modelCatalog}
          local={local}
          claudeAvailable={claudeAvailable}
          machineReplies={machineReplies}
          onPick={pickModel}
        />
      ) : null}
    </>
  );
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {shellSlot ? (
        createPortal(header, shellSlot)
      ) : (
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-white/[0.06] px-4">{header}</div>
      )}
      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          onWindowScroll();
          if (stick.current) settle();
        }}
      >
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-5 pb-6 pt-5">
          {thread.messages.length === 0 && pending.length === 0 && !working && (
            <div className="mt-16 text-center text-[13px] leading-relaxed text-neutral-500">
              Text {bot.name} like a person: send as many messages as you like.
            </div>
          )}
          {olderAbove && (
            // Earlier messages load as you scroll up; it spins only while a page loads.
            <div className="flex h-5 justify-center text-neutral-600" aria-label="Earlier messages load as you scroll up">
              {loadingOlder && <Loader2 size={12} className="animate-spin" />}
            </div>
          )}
          {timeline.map((row) =>
            row.kind === 'message' ? (
              <div key={row.message.id} data-bot-row={row.message.id} className="flex flex-col">
                <BotMessage
                  bot={rowBot}
                  projectPath={projectPath}
                  message={row.message}
                  handlers={handlers}
                  answeredQuestions={answeredQuestions}
                  uploadStatuses={row.message.role === 'user' && row.message.files?.some((file) => file.pendingId) ? uploadStatuses : undefined}
                  onRetryAttachment={retryAttachment}
                  onReplyTo={replyToMessage}
                  onJumpTo={jumpToMessage}
                />
              </div>
            ) : (
              liveRow(row.reply)
            )
          )}
          {range.following && pending.map((message) => (
            <PersonBubble
              key={message.id}
              content={message.content}
              onJumpTo={jumpToMessage}
              files={message.files?.map((file, index) => {
                const pendingId = message.pendingIds?.[index];
                const liveStatus = pendingId ? uploadStatuses.get(pendingId) : undefined;
                const status = liveStatus?.status ?? (pendingId ? 'uploading' : undefined);
                return {
                  name: file.name,
                  size: file.size,
                  preview: file.preview,
                  ...(status === 'uploading' || status === 'failed' ? { status } : {}),
                  ...(liveStatus?.error ? { error: liveStatus.error } : {}),
                  ...(status === 'failed' && pendingId && liveStatus?.canRetry !== false
                    ? { onRetry: () => void retryAttachment(message.id, pendingId) }
                    : {}),
                };
              })}
              meta={
                message.failed ? (
                  <button type="button" className="text-red-400 hover:underline" onClick={() => void send(message.content, message.files ?? [], message.id)}>
                    {message.failed} Retry
                  </button>
                ) : message.sent ? null : (
                  // Shown only if sending takes a moment (fades in after ~1 s).
                  <span className="bot-sending">Sending…</span>
                )
              }
            />
          ))}
          {range.following && unplaced.map(liveRow)}
          {range.following && starting && (
            <AssistantRow bot={bot} projectPath={projectPath}>
              <div className="flex items-center gap-1.5 text-[11.5px] text-neutral-500">
                <Loader2 size={11} className="animate-spin" /> Starting…
              </div>
            </AssistantRow>
          )}
        </div>
      </div>
      {!range.following && (
        <button
          type="button"
          onClick={() => {
            stick.current = true;
            toLatest();
          }}
          className="absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full bg-neutral-800/95 px-3 text-[12px] text-neutral-200 shadow-lg ring-1 ring-white/10 transition-colors duration-75 hover:bg-neutral-700"
        >
          <ArrowDown size={12} /> Latest messages
        </button>
      )}
      </div>
      <BotNeedsYouPanel botId={bot.id} requests={requests} handlers={userActionHandlers} onOpenThread={onOpenThread} />
      <BotComposer
        draftKey={botDraftKey(bot.id)}
        botName={bot.name}
        paused={bot.paused}
        replyTo={replyTarget}
        onClearReply={() => setReplyTarget(null)}
        onJumpTo={jumpToMessage}
        onSend={(text, files) => {
          const target = replyTarget;
          setReplyTarget(null);
          void send(text, files, undefined, target);
        }}
      />
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

/** The strip above the panels: where the project lives, and who checks its library on demand. */
const LibraryAbout: React.FC<{ path: string | null; bots: DesktopBot[]; onOpenBot: (botId: string) => void }> = ({ path, bots, onOpenBot }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const primaryProjectBot = bots[0] ?? null;
  const anyWorking = bots.some((item) => botIsWorking(item));
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
      {primaryProjectBot ? (
        <button
          type="button"
          onClick={() => onOpenBot(primaryProjectBot.id)}
          title={`Open ${primaryProjectBot.name}`}
          className="flex min-w-0 items-center gap-2 rounded-lg py-1 pl-1.5 pr-2.5 text-[12px] text-neutral-400 transition-colors duration-75 hover:bg-white/[0.05] hover:text-neutral-200"
        >
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[13px]" aria-hidden>
            <BotIcon bot={primaryProjectBot} px={18} projectPath={path} />
          </span>
          <span className="truncate">
            {bots.length === 1 ? (
              <>
                Checked on demand by <span className="font-medium text-neutral-200">{primaryProjectBot.name}</span> and project threads
              </>
            ) : (
              <>
                Checked on demand by <span className="font-medium text-neutral-200">{bots.length} bots</span> and project threads
              </>
            )}
          </span>
          {anyWorking && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-[12px] text-neutral-500">
          <Bot size={14} className="shrink-0" />
          <span className="truncate">No bots yet. Project threads can check this library on demand.</span>
        </span>
      )}
    </div>
  );
};

const NoteAuthor: React.FC<{ author: string; bots: DesktopBot[]; projectPath?: string | null }> = ({
  author,
  bots,
  projectPath,
}) => {
  const matched = bots.find((candidate) => candidate.name === author) ?? null;
  return matched ? (
    <span className="flex h-3.5 w-3.5 items-center justify-center text-[10px]" aria-hidden>
      <BotIcon bot={matched} px={14} projectPath={bots.length === 1 ? projectPath : null} />
    </span>
  ) : (
    <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white/[0.08] text-neutral-400" aria-hidden>
      <UserRound size={9} />
    </span>
  );
};

const NoteCard: React.FC<{ note: BotProjectNote; bots: DesktopBot[]; projectPath?: string | null; onDelete: () => void }> = ({
  note,
  bots,
  projectPath,
  onDelete,
}) => {
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
        <NoteAuthor author={note.author} bots={bots} projectPath={projectPath} />
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

/** Context: project notes that bots and threads check on demand. Deleting waits a moment, so it can be undone. */
const ContextPanel: React.FC<{
  notes: BotProjectNote[] | null;
  bots: DesktopBot[];
  projectPath?: string | null;
  onAdd: (content: string) => Promise<boolean>;
  onDelete: (noteId: string) => void;
  /** One column: fold long lists. */
  fold: boolean;
}> = ({ notes, bots, projectPath, onAdd, onDelete, fold }) => {
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
      description="Facts, rules and decisions bots and threads pull when relevant."
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
            Short facts bots and threads on this project can pull when relevant: goals, conventions, people to ask, things to avoid. For example:
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
              <NoteCard key={note.id} note={note} bots={bots} projectPath={projectPath} onDelete={() => remove(note.id)} />
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
  bots: DesktopBot[];
  onOpenBot: (botId: string) => void;
}> = ({ target, name, path, bots, onOpenBot }) => {
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
      <LibraryAbout path={path} bots={bots} onOpenBot={onOpenBot} />
      <div className={`mt-3 ${wide ? 'grid grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-start gap-3' : 'flex flex-col gap-3'}`}>
        <ContextPanel
          notes={project?.notes ?? (error ? [] : null)}
          bots={bots}
          projectPath={path}
          onAdd={addNote}
          onDelete={(noteId) => void act({ ...target, action: 'delete_note', noteId })}
          fold={!wide}
        />
        <FilesPanel
          files={project?.files ?? (error ? [] : null)}
          bot={bots[0] ?? null}
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

type BubbleFile = {
  name: string;
  size?: number;
  preview?: string;
  status?: 'uploading' | 'ready' | 'failed';
  error?: string;
  onRetry?: () => void;
};

/** Reply: quote this message in the composer (next to Copy, on hover). */
const ReplyMessageButton: React.FC<{ onClick: () => void; className?: string }> = ({ onClick, className }) => (
  <button
    type="button"
    className={`message-copy-btn bot-reply-btn${className ? ` ${className}` : ''}`}
    onClick={onClick}
    aria-label="Reply to this message"
    title="Reply"
  >
    <Reply size={14} />
  </button>
);

/** The message a reply answers, above its text: who wrote it and how it starts; clicking jumps to it. */
const ReplyQuoteHeader: React.FC<{ author: string; excerpt: string; seq: number; onJump?: (seq: number) => void }> = ({ author, excerpt, seq, onJump }) => (
  <button
    type="button"
    onClick={() => onJump?.(seq)}
    disabled={!onJump}
    title={onJump ? 'Show the message this replies to' : undefined}
    className="bot-reply-quote mb-1.5 flex w-full min-w-0 items-center gap-1.5 rounded-md border-l-2 border-sky-400/50 bg-white/[0.04] py-1 pl-2 pr-2.5 text-left text-[12px] leading-snug text-neutral-400 transition-colors duration-75 enabled:hover:bg-white/[0.07] enabled:hover:text-neutral-300"
  >
    <Reply size={11} className="shrink-0 text-sky-400/80" />
    <span className="shrink-0 font-medium text-neutral-300">{botReplyDisplayAuthor(author)}</span>
    <span className="min-w-0 truncate">{excerpt}</span>
  </button>
);

const PersonBubble: React.FC<{
  content: string;
  files?: BubbleFile[];
  meta?: React.ReactNode;
  copyable?: boolean;
  onReplyTo?: () => void;
  onJumpTo?: (seq: number) => void;
}> = ({ content: stored, files, meta, copyable = true, onReplyTo, onJumpTo }) => {
  // A reply to an earlier message: its quote line is drawn as a compact header.
  const quote = parseBotReplyQuote(stored);
  const content = quote ? quote.text : stored;
  const answer = /^> \*\*Answering:\*\* (.+)\n\n([\s\S]+)$/.exec(content);
  const images = files?.filter((file) => file.preview) ?? [];
  const others = files?.filter((file) => !file.preview) ?? [];
  return (
    <div className="flex flex-col items-end gap-1">
      {images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {images.map((file, index) => (
            <div key={`${file.name}-${index}`} className="flex flex-col items-end gap-1">
              <div
                className={`relative inline-block overflow-hidden rounded-xl ring-1 ${
                  file.status === 'failed' ? 'ring-red-400/55' : 'ring-white/[0.08]'
                }`}
              >
                <img
                  src={file.preview}
                  alt={file.name}
                  title={file.status === 'failed' && file.error ? `${file.name} — ${file.error}` : file.name}
                  onClick={handleLightboxImageClick}
                  className="block max-h-[180px] max-w-[260px] cursor-zoom-in object-cover"
                />
                {file.status === 'uploading' && (
                  <span
                    className="pointer-events-none absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-full bg-black/75 px-2 py-0.5 text-[10.5px] font-medium text-neutral-200 ring-1 ring-white/15 backdrop-blur-sm"
                    aria-label={`Uploading ${file.name}`}
                  >
                    <Loader2 size={10} className="animate-spin text-sky-400" />
                    Uploading
                  </span>
                )}
                {file.status === 'failed' && (
                  <div className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-between gap-2 rounded-lg bg-black/85 px-2 py-1 text-[11px] text-red-300 ring-1 ring-red-400/35 backdrop-blur-sm">
                    <span className="inline-flex min-w-0 items-center gap-1 truncate" title={file.error || 'Upload failed'}>
                      <AlertCircle size={11} className="shrink-0 text-red-400" />
                      <span className="truncate">Upload failed</span>
                    </span>
                    {file.onRetry && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          file.onRetry?.();
                        }}
                        className="inline-flex shrink-0 items-center gap-1 rounded bg-white/15 px-1.5 py-0.5 text-[10.5px] font-medium text-neutral-100 transition-colors hover:bg-white/25"
                      >
                        <RotateCw size={10} />
                        Retry
                      </button>
                    )}
                  </div>
                )}
              </div>
              {file.status === 'failed' && file.error && file.error !== 'Upload failed' && file.error !== 'Upload failed.' && (
                <span className="max-w-[260px] truncate pr-0.5 text-[11px] text-red-300/90" title={file.error}>
                  {file.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {others.map((file, index) => (
            <div key={`${file.name}-${index}`} className="flex flex-col items-end gap-0.5">
              <span
                className={`inline-flex max-w-[300px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] ring-1 ${
                  file.status === 'failed'
                    ? 'bg-red-500/[0.08] text-red-200 ring-red-400/35'
                    : 'bg-white/[0.06] text-neutral-300 ring-white/[0.08]'
                }`}
                title={file.status === 'failed' && file.error ? `${file.name} — ${file.error}` : file.name}
              >
                {file.status === 'failed' ? (
                  <AlertCircle size={12} className="shrink-0 text-red-400" />
                ) : (
                  <Paperclip size={12} className="shrink-0 text-neutral-500" />
                )}
                <span className="truncate">{file.name}</span>
                {file.size ? <span className="shrink-0 text-neutral-500">{formatFileSize(file.size)}</span> : null}
                {file.status === 'uploading' && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-neutral-400" aria-label={`Uploading ${file.name}`}>
                    <Loader2 size={10} className="animate-spin text-sky-400" />
                    Uploading
                  </span>
                )}
                {file.status === 'failed' && (
                  <>
                    <span className="shrink-0 text-[11px] text-red-300">Failed</span>
                    {file.onRetry && (
                      <button
                        type="button"
                        onClick={() => file.onRetry?.()}
                        className="inline-flex shrink-0 items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[10.5px] font-medium text-neutral-100 transition-colors hover:bg-white/20"
                      >
                        <RotateCw size={10} />
                        Retry
                      </button>
                    )}
                  </>
                )}
              </span>
              {file.status === 'failed' && file.error && file.error !== 'Upload failed' && file.error !== 'Upload failed.' && (
                <span className="max-w-[300px] truncate pr-0.5 text-[11px] text-red-300/90" title={file.error}>
                  {file.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {(content.trim() !== '' || quote) && (
        <div className={`bot-msg user relative max-w-[85%]${quote ? ' min-w-[220px]' : ''}`}>
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-white/[0.08] px-3.5 py-2 text-[13.5px] leading-relaxed text-neutral-100">
            {quote && <ReplyQuoteHeader author={quote.author} excerpt={quote.excerpt} seq={quote.seq} onJump={onJumpTo} />}
            {answer ? (
              <>
                <span className="mb-1 block border-l-2 border-sky-400/50 pl-2 text-[12px] text-neutral-400">{answer[1]}</span>
                {answer[2]}
              </>
            ) : (
              content
            )}
          </div>
          {copyable && <CopyMessageButton text={copyText(content, files)} />}
          {onReplyTo && <ReplyMessageButton onClick={onReplyTo} />}
        </div>
      )}
      {meta && <span className="pr-1 text-[11px] text-neutral-500">{meta}</span>}
    </div>
  );
};

const AssistantRow: React.FC<{ bot: DesktopBot; projectPath?: string | null; children: React.ReactNode; copy?: string; onReplyTo?: () => void }> = ({
  bot,
  projectPath,
  children,
  copy,
  onReplyTo,
}) => (
  <div className={`flex items-start gap-2.5${copy ? ' bot-msg agent' : ''}`}>
    <BotAvatar bot={bot} projectPath={projectPath} />
    <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-neutral-200">
      {children}
      {copy && (
        <div className="bot-msg-actions">
          <CopyMessageButton text={copy} />
          {onReplyTo && <ReplyMessageButton onClick={onReplyTo} />}
        </div>
      )}
    </div>
  </div>
);

const INBOX_ICON = { routine: CalendarClock, task: ListChecks, bot: Bot } as const;

const BotMessage: React.FC<{
  bot: DesktopBot;
  projectPath?: string | null;
  message: DesktopBotMessage;
  handlers: BotActionHandlers;
  answeredQuestions: ReadonlyMap<string, string>;
  uploadStatuses?: ReadonlyMap<string, BotAttachmentUploadStatus>;
  onRetryAttachment?: (messageId: string, pendingId: string) => void;
  /** Reply to this message (the composer quotes it); stable across redraws. */
  onReplyTo?: (message: DesktopBotMessage) => void;
  /** A reply quote was clicked: show the message it answers. */
  onJumpTo?: (seq: number) => void;
}> = React.memo(({ bot, projectPath, message, handlers, answeredQuestions, uploadStatuses, onRetryAttachment, onReplyTo, onJumpTo }) => {
  const files = useMessageFiles(message.files);
  const replyTo = onReplyTo ? () => onReplyTo(message) : undefined;
  if (message.role === 'assistant') {
    const via = message.authorLabel?.startsWith('via ') ? message.authorLabel : null;
    // Files it attached show under the text (a path it names would show twice).
    const showsFiles = files.length > 0 || Boolean(message.cards?.some((card) => card.component === 'asset-gallery'));
    return (
      <AssistantRow bot={bot} projectPath={projectPath} copy={copyText(message.content, message.files)} onReplyTo={replyTo}>
        <MarkdownContent content={message.content} pathPreviews={!showsFiles} refLinks />
        <BotFileGallery files={files} />
        {message.cards?.length ? <BotCards cards={message.cards} handlers={handlers} answeredQuestions={answeredQuestions} messageId={message.id} /> : null}
        {via && <div className="mt-1 text-[11px] text-neutral-600">{via}</div>}
      </AssistantRow>
    );
  }
  const source = botInboxSource(message.authorLabel);
  if (source === 'person') {
    return (
      <PersonBubble
        content={message.content}
        files={withSentPreviews(message.id, personFiles(message.id, message.files, files, uploadStatuses, onRetryAttachment))}
        onReplyTo={replyTo}
        onJumpTo={onJumpTo}
      />
    );
  }
  const Icon = INBOX_ICON[source];
  // A task report carries its thread and change: open or ship them from here.
  const actions = source === 'task' ? taskReportActions(message.content) : [];
  return (
    <div className="bot-msg inbox mx-auto w-full max-w-[92%] rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-[12.5px]">
      {replyTo && <ReplyMessageButton onClick={replyTo} />}
      <div className="flex items-center gap-1.5 text-neutral-400">
        <Icon size={12} />
        <span className="truncate font-medium text-neutral-300">{message.authorLabel}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10.5px] text-neutral-600">
          {message.silentRead && (
            <span
              className="inline-flex items-center gap-0.5 text-neutral-500"
              title={message.silentRead.reason ? `Read without replying: ${message.silentRead.reason}` : 'Read without replying'}
            >
              <Check size={10} />
              Read
            </span>
          )}
          {message.silentRead && <span aria-hidden="true">·</span>}
          <span>{relativeBotTime(message.createdAt)}</span>
        </span>
      </div>
      <div className="mt-1 line-clamp-4 whitespace-pre-wrap text-neutral-400">{source === 'task' ? taskReportBody(message.content) : message.content}</div>
      {actions.length > 0 && <BotActionsRow actions={actions} handlers={handlers} />}
    </div>
  );
});

/** The person's files with thumbnail, background upload badge, and retry action when failed on this computer. */
const personFiles = (
  messageId: string,
  stored: DesktopBotMessage['files'],
  shown: ReturnType<typeof useMessageFiles>,
  uploadStatuses?: ReadonlyMap<string, BotAttachmentUploadStatus>,
  onRetryAttachment?: (messageId: string, pendingId: string) => void
): BubbleFile[] | undefined =>
  stored?.map((file, index) => {
    const loaded = shown[index];
    const live = file.pendingId ? uploadStatuses?.get(file.pendingId) : undefined;
    const contentType = loaded?.contentType ?? live?.contentType ?? file.contentType ?? '';
    const image = /^image\/(png|jpe?g|gif|webp)$/i.test(contentType);
    const localPath = loaded?.path ?? live?.localPath;
    const preview = image ? loaded?.url ?? (localPath ? localMediaSrc(localPath, []) : undefined) : undefined;
    const status = live ? live.status : file.assetId ? 'ready' : file.status;
    const error = live?.error ?? file.error;
    const canRetry = Boolean(status === 'failed' && file.pendingId && live?.localPath && live?.canRetry !== false && onRetryAttachment);
    return {
      name: file.name,
      ...(file.size ? { size: file.size } : {}),
      ...(preview ? { preview } : {}),
      ...(status === 'uploading' || status === 'failed' ? { status } : {}),
      ...(error ? { error } : {}),
      ...(canRetry ? { onRetry: () => onRetryAttachment!(messageId, file.pendingId!) } : {}),
    };
  });

/** Always open: messages queue while the bot works, like texting a person. */
const BOT_ATTACHMENTS_MAX = 10;

/** A file from the clipboard or a drop with no path on disk: saved to a temp file first (bots:saveAttachment). */
const PREVIEW_TYPES = /^image\/(png|jpeg|gif|webp)$/;

const fileToAttachment = async (file: File): Promise<BotAttachmentFile | null> => {
  const filePath = window.orion?.getPathForFile?.(file) ?? '';
  // A blob: URL thumbnail, released when the file is removed (or its sent message is forgotten).
  const withPreview = (attachment: BotAttachmentFile): BotAttachmentFile =>
    PREVIEW_TYPES.test(file.type) ? { ...attachment, preview: URL.createObjectURL(file) } : attachment;
  if (filePath) return withPreview({ path: filePath, name: file.name || 'file', size: file.size });
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
  const extension = file.type.startsWith('image/') ? `.${file.type.slice('image/'.length).replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')}` : '';
  const result = await window.orion?.saveBotAttachment?.({ name: file.name || `pasted${extension}`, data: btoa(binary) });
  return result?.ok && result.file ? withPreview(result.file) : null;
};

/** Always open: messages queue while the bot works, like texting a person. Files attach by button, paste or drop. */
const BotComposer: React.FC<{
  draftKey: string;
  botName: string;
  paused: boolean;
  /** The message this one replies to: quoted above the box until sent or dismissed. */
  replyTo?: BotReplyTarget | null;
  onClearReply?: () => void;
  onJumpTo?: (seq: number) => void;
  onSend: (text: string, files: BotAttachmentFile[]) => void;
}> = ({ draftKey, botName, paused, replyTo = null, onClearReply, onJumpTo, onSend }) => {
  // The unsent draft (text and files) comes back after switching bots, tabs or threads, and after a restart.
  const [initialDraft] = useState(() => loadBotDraft(draftKey));
  const [text, setText] = useState(initialDraft.text);
  const [files, setFiles] = useState<BotAttachmentFile[]>(initialDraft.files);
  const draftSaver = useBotDraftSaver(draftKey);
  useEffect(() => draftSaver.save(text, files), [draftSaver, text, files]);
  const [dragging, setDragging] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const atBottomRef = useRef(true);
  // Reply picked on a message: type the answer straight away.
  const replyKey = replyTo ? `${replyTo.id}:${replyTo.seq}` : '';
  useEffect(() => {
    if (!replyKey) return;
    const element = ref.current;
    if (!element) return;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
  }, [replyKey]);
  useEffect(
    () => () => {
      if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    },
    []
  );
  const handleScroll = (event: React.UIEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 2;
    setScrolling(true);
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = null;
      setScrolling(false);
    }, 900);
  };
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const prevScrollTop = element.scrollTop;
    const stickToBottom =
      atBottomRef.current &&
      (document.activeElement !== element || element.selectionEnd === element.value.length);
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
    if (element.scrollHeight > element.clientHeight) {
      element.scrollTop = stickToBottom ? element.scrollHeight : prevScrollTop;
    }
    atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  }, [text]);
  // Thumbnails still in the box when it goes away are released (sent ones belong to their message).
  const filesRef = useRef(files);
  filesRef.current = files;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      filesRef.current.forEach((file) => releasePreview(file.preview));
    };
  }, []);
  const add = (next: BotAttachmentFile[]) => {
    setAttachError(null);
    const merged = [...filesRef.current];
    for (const file of next) {
      if (merged.some((item) => item.path === file.path) || merged.length >= BOT_ATTACHMENTS_MAX) releasePreview(file.preview);
      else merged.push(file);
    }
    if (filesRef.current.length + next.length > BOT_ATTACHMENTS_MAX) setAttachError(`Up to ${BOT_ATTACHMENTS_MAX} files per message.`);
    filesRef.current = merged;
    setFiles(merged);
  };
  const remove = (file: BotAttachmentFile) => {
    releasePreview(file.preview);
    filesRef.current = filesRef.current.filter((item) => item.path !== file.path);
    setFiles(filesRef.current);
  };
  const addFiles = async (list: FileList | File[]) => {
    const picked = await Promise.all([...list].map((file) => fileToAttachment(file).catch(() => null)));
    const ok = picked.filter((file): file is BotAttachmentFile => Boolean(file));
    if (!mountedRef.current) {
      // Composer unmounted while staging (e.g. switched bots): release transient
      // previews and save the files into the original bot's draft.
      ok.forEach((file) => releasePreview(file.preview));
      appendBotDraftFiles(draftKey, ok, BOT_ATTACHMENTS_MAX);
      return;
    }
    if (ok.length < picked.length) setAttachError('Some files couldn’t be attached.');
    add(ok);
  };
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(
    () =>
      registerBotFileDropHandler({
        botName,
        onDrop: (dropped) => void addFilesRef.current(dropped),
      }),
    [botName]
  );
  useEffect(() => {
    if (!dragging) return undefined;
    const clear = () => setDragging(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear();
    };
    window.addEventListener('dragend', clear);
    window.addEventListener('blur', clear);
    window.addEventListener('drop', clear, true);
    window.addEventListener('pointermove', clear, true);
    window.addEventListener('mousedown', clear, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('blur', clear);
      window.removeEventListener('drop', clear, true);
      window.removeEventListener('pointermove', clear, true);
      window.removeEventListener('mousedown', clear, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [dragging]);
  const pick = async () => {
    const result = await window.orion?.pickBotAttachments?.();
    if (!result) return;
    if (!mountedRef.current) {
      if (result.ok && result.files?.length) {
        result.files.forEach((file) => releasePreview(file.preview));
        appendBotDraftFiles(draftKey, result.files, BOT_ATTACHMENTS_MAX);
      }
      return;
    }
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
    filesRef.current = [];
    setFiles([]);
    setAttachError(null);
    ref.current?.focus();
  };
  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className="mx-auto w-full max-w-[760px]">
        {paused && <div className="mb-1.5 text-center text-[11.5px] text-[var(--text-muted)]">{botName} is paused: messages wait until you resume it.</div>}
        <div
          className={`composer-shell bot-composer${dragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(event) => {
            setDragging(false);
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            void addFiles(event.dataTransfer.files);
          }}
        >
          {replyTo && (
            <div className="bot-reply-preview flex items-start gap-2 px-3 pb-0.5 pt-2.5">
              <Reply size={13} className="mt-[3px] shrink-0 text-sky-400/90" />
              <button
                type="button"
                onClick={() => onJumpTo?.(replyTo.seq)}
                title="Show the message you're replying to"
                className="min-w-0 flex-1 rounded-md border-l-2 border-sky-400/50 bg-white/[0.04] py-1 pl-2 pr-2 text-left transition-colors duration-75 hover:bg-white/[0.07]"
              >
                <span className="block text-[11.5px] font-medium leading-snug text-[var(--text-secondary)]">
                  Replying to {replyTo.author === 'my message' ? 'your message' : replyTo.author}
                  {replyTo.when ? <span className="font-normal text-[var(--text-muted)]"> · {replyTo.when}</span> : null}
                </span>
                <span className="line-clamp-2 block text-[12px] leading-snug text-[var(--text-muted)]">{replyTo.excerpt}</span>
              </button>
              <button
                type="button"
                aria-label="Don't reply to this message"
                title="Cancel reply (Esc)"
                onClick={() => {
                  onClearReply?.();
                  ref.current?.focus();
                }}
                className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors duration-75 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <X size={13} />
              </button>
            </div>
          )}
          {files.length > 0 && (
            <div className="composer-attachments items-end">
              {files.map((file) =>
                file.preview ? (
                  <span key={file.path} className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[var(--border-default)]" title={`${file.name} · ${formatFileSize(file.size)}`}>
                    <img src={file.preview} alt={file.name} onClick={handleLightboxImageClick} className="h-full w-full cursor-zoom-in object-cover" />
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => remove(file)}
                      className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-neutral-200 opacity-0 transition-opacity hover:bg-black/90 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ) : (
                  <span key={file.path} className="inline-flex max-w-[240px] items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] py-1 pl-2.5 pr-1 text-[12px] text-[var(--text-primary)]">
                    <Paperclip size={12} className="shrink-0 text-[var(--text-muted)]" />
                    <span className="truncate">{file.name}</span>
                    <span className="shrink-0 text-[var(--text-muted)]">{formatFileSize(file.size)}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => remove(file)}
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      <X size={11} />
                    </button>
                  </span>
                )
              )}
            </div>
          )}
          <textarea
            ref={ref}
            value={text}
            rows={2}
            placeholder={replyTo ? `Reply to ${replyTo.author === 'my message' ? 'your message' : replyTo.author}` : `Message ${botName}`}
            onChange={(event) => setText(event.target.value)}
            onScroll={handleScroll}
            onPaste={(event) => {
              if (!event.clipboardData.files.length) return;
              event.preventDefault();
              void addFiles(event.clipboardData.files);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              } else if (event.key === 'Escape' && replyTo && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                onClearReply?.();
              }
            }}
            className={`chat-input min-h-[52px]${scrolling ? ' is-scrolling' : ''}`}
          />
          <div className="composer-controls">
            <button
              type="button"
              aria-label="Attach files"
              title="Attach files (or paste, or drop them here)"
              onClick={() => void pick()}
              className="attachment-trigger ml-auto"
            >
              <Paperclip size={15} />
            </button>
            <button
              type="button"
              aria-label="Send"
              title="Send"
              onClick={submit}
              disabled={!text.trim() && !files.length}
              className="send-button"
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </div>
        </div>
        {attachError && <div className="mt-1 px-1 text-[11.5px] text-[var(--danger)]">{attachError}</div>}
      </div>
    </div>
  );
};
