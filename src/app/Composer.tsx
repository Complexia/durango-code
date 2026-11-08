import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  ArrowUp,
  Bot,
  Eraser,
  GitBranch,
  ListPlus,
  MessageCircle,
  MessageSquare,
  Play,
  Plug,
  Sparkles,
  Square,
  SquarePen,
  SquareSlash,
  Target,
  X,
  Zap,
} from 'lucide-react';
import type { Project, Thread } from '../store';
import type { OrionMcpEntry, SlashCommandInfo } from '../types';
import { agentProviders, claudeCodeCliModelId, isClaudeCodeCliModelId, type AgentModel, type AgentProviderId } from '../agentCatalog';
import { THREAD_DRAG_MIME } from './AgentsSidebar';
import { AttachmentThumb, attachmentKindLabel, formatAttachmentSize } from './attachments';
import { SnapShotAttachmentBadge, openSnapShotOutline } from './SnapShotSettings';
import { ComposerPopover } from './ComposerPopover';
import { modelMentionToken, threadMentionToken } from './promptContext';
import { getThreadSearchEntry, parseSearchQuery, scoreThreadSearchEntry } from './threadSearch';
import {
  allowsThreadMentionsInComposer,
  getChatMentionReplaceEnd,
  isThreadReferenceCandidate,
} from './chatMentions';
import { chatMentionToken, formatChatUpdatedAt, rememberDurangoChats, type DurangoChatRef } from './durangoChats';
import {
  buildSlashCommandCandidates,
  completedSlashCommand,
  filterSlashCommands,
  getSlashToken,
  type SlashCommandCandidate,
} from './slashCommands';
import { formatShortTime, getThreadActivityTime } from './time';
import type { ComposerDraftController } from './composerDraft';

// The composer: draft text, attachments, the @-mention and slash-command
// dropdowns, and the send/queue/steer/stop buttons. It owns everything that
// changes per keystroke, so typing re-renders this component only. The draft
// itself lives in the ComposerDraftController (App reads it at event time);
// App-owned chrome (task chips, MCP chips, model/settings controls) comes in
// as ready-made nodes, which React skips when only the composer re-renders.

// One row of the composer's @-mention dropdown. The root level offers the
// mention kinds; picking one (or just typing) narrows to models or threads.
type ChatMentionMode = 'model' | 'thread' | 'mcp' | 'chat';
type ChatMentionCandidate =
  | { kind: 'category'; category: ChatMentionMode; label: string; hint: string }
  | { kind: 'model'; model: AgentModel }
  | { kind: 'thread'; thread: Thread; projectName: string }
  | { kind: 'mcp'; server: OrionMcpEntry }
  | { kind: 'chat'; chat: DurangoChatRef }
  // Non-selectable row for the Durango chat list: loading, empty, or why it
  // is unavailable. `action` makes Enter/click do something useful.
  | { kind: 'chatStatus'; message: string; action?: 'sign-in' };

type ChatMention = { start: number; query: string; mode?: ChatMentionMode };

const chatMentionCategories: Array<Extract<ChatMentionCandidate, { kind: 'category' }>> = [
  { kind: 'category', category: 'model', label: 'Model', hint: 'delegate to a model' },
  { kind: 'category', category: 'thread', label: 'Thread', hint: 'reference another thread' },
  { kind: 'category', category: 'chat', label: 'Durango chats', hint: 'reference a Durango Chat conversation' },
  { kind: 'category', category: 'mcp', label: 'MCP', hint: 'use a connected MCP server' },
];

// Results of the @chat dropdown's Durango search (main → GET /api/v1/chats).
type DurangoChatSearchState = {
  query: string;
  status: 'loading' | 'ready' | 'error';
  chats: DurangoChatRef[];
  code?: string;
  error?: string;
};
const DURANGO_CHAT_SEARCH_DEBOUNCE_MS = 250;

// The thread list inside the @-mention dropdown loads this many rows at a time;
// scrolling (or arrowing) to the bottom appends the next page.
const CHAT_MENTION_THREAD_PAGE = 20;

// The sidebar's "Recent agents" ordering: running agents are active "now", so
// they always rank above finished ones. Among running agents, keep start order
// so the list doesn't reshuffle as they stream; finished agents sort by their
// last activity (i.e. when they finished) — or by when they were unpinned, so
// a just-unpinned thread surfaces at the top instead of sinking back to its
// old chronological spot. (Also the order of App's Recent agents list.)
export const compareRecentThreadOrder = (a: Thread, b: Thread) => {
  const aRunning = a.status === 'running';
  const bRunning = b.status === 'running';
  if (aRunning !== bRunning) return aRunning ? -1 : 1;
  if (aRunning) {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  }
  const recentRank = (t: Thread) =>
    Math.max(
      getThreadActivityTime(t).getTime(),
      t.unpinnedAt ? new Date(t.unpinnedAt).getTime() : Number.NEGATIVE_INFINITY
    );
  return recentRank(b) - recentRank(a);
};

const isThreadDrag = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes(THREAD_DRAG_MIME);

// A stable function that always calls the latest `callback`, so App can hand
// the composer handlers without changing their identity on every App render.
export const useLatestCallback = <Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): ((...args: Args) => Result) => {
  const ref = useRef(callback);
  useLayoutEffect(() => {
    ref.current = callback;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
};

// Subscribes to the controller's draft snapshot.
export const useComposerDraft = (controller: ComposerDraftController) =>
  useSyncExternalStore(controller.subscribe, controller.getSnapshot);

export type ComposerReviewRequest = { mode: 'uncommitted' } | { mode: 'base'; base: string };

export type ComposerProps = {
  controller: ComposerDraftController;
  threadId: string;
  // What the mention and slash dropdowns offer.
  agentModels: AgentModel[];
  enabledProviderIds: ReadonlySet<string>;
  orionMcps: OrionMcpEntry[];
  threads: Thread[];
  projects: Project[];
  canReferenceThreads: boolean;
  liveSlashCommands: SlashCommandInfo[] | null;
  reviewBranches: string[];
  // The selected thread's model and state.
  providerId: AgentProviderId | null;
  modelAvailable: boolean;
  claudeBacked: boolean;
  btwAvailable: boolean;
  isTerminalThread: boolean;
  isNativeSubagentThread: boolean;
  workspaceUnavailable: boolean;
  workspaceRemoving: boolean;
  isSending: boolean;
  steerSupported: boolean;
  steerReady: boolean;
  pendingLinkedTaskCount: number;
  // App-owned rows and controls.
  taskRow?: ReactNode;
  mcpRow?: ReactNode;
  // The controls row's own chips (model picker, settings, attach), before the
  // send buttons.
  children: ReactNode;
  controlsClassName: string;
  controlsRef: (node: HTMLDivElement | null) => void;
  // Stable handlers (see useLatestCallback).
  onSend: (overrideText?: string) => void;
  onSteer: () => void;
  onStop: () => void;
  onDispatchReview: (rawText: string, review: ComposerReviewRequest) => void;
  onOpenAccountSettings: () => void;
  // A sidebar thread is being dragged over the composer.
  onThreadDragOver: () => void;
};

export const Composer = ({
  controller,
  threadId,
  agentModels,
  enabledProviderIds,
  orionMcps,
  threads,
  projects,
  canReferenceThreads,
  liveSlashCommands,
  reviewBranches,
  providerId,
  modelAvailable,
  claudeBacked,
  btwAvailable,
  isTerminalThread,
  isNativeSubagentThread,
  workspaceUnavailable,
  workspaceRemoving,
  isSending,
  steerSupported,
  steerReady,
  pendingLinkedTaskCount,
  taskRow,
  mcpRow,
  children,
  controlsClassName,
  controlsRef,
  onSend,
  onSteer,
  onStop,
  onDispatchReview,
  onOpenAccountSettings,
  onThreadDragOver,
}: ComposerProps) => {
  const draft = useComposerDraft(controller);
  const chatInput = draft.text;
  const chatAttachments = draft.attachments;
  const starting = draft.starting.has(threadId);
  const hasPendingLinkedTasks = pendingLinkedTaskCount > 0;
  const hasDraftContent = !!chatInput.trim() || chatAttachments.length > 0;

  // Active @-mention token in the composer: index of the '@' and the query
  // typed after it (null when the caret isn't inside a mention token). `mode`
  // is set once the user picks a kind from the root dropdown level; while
  // unset, typing filters models directly (the pre-thread-mentions behavior).
  const [chatMention, setChatMention] = useState<ChatMention | null>(null);
  const [chatMentionIndex, setChatMentionIndex] = useState(0);
  // How many thread rows the @-mention dropdown currently shows; grows as the
  // user scrolls and resets whenever the thread query changes.
  const [chatMentionThreadLimit, setChatMentionThreadLimit] = useState(CHAT_MENTION_THREAD_PAGE);
  const [durangoChatSearch, setDurangoChatSearch] = useState<DurangoChatSearchState | null>(null);
  // Slash-command menu (Claude Code style): the highlighted row, and the
  // exact draft dismissed with Escape (any edit reopens the menu).
  const [slashCommandIndex, setSlashCommandIndex] = useState(0);
  const [slashDismissedDraft, setSlashDismissedDraft] = useState<string | null>(null);
  // Start offset of a token dismissed with Escape, so it stays closed until
  // the user begins a new mention.
  const chatMentionDismissRef = useRef<number | null>(null);
  const chatMentionRef = useRef<ChatMention | null>(null);
  useEffect(() => {
    chatMentionRef.current = chatMention;
  }, [chatMention]);

  // The text this component last wrote. Anything else changed the draft from
  // outside the textarea (send cleared it, a failed send restored it, a
  // thread switch swapped it): no caret-based mention token survives that.
  const localTextRef = useRef(chatInput);
  const setLocalText = useCallback(
    (value: string) => {
      localTextRef.current = value;
      controller.setText(value);
    },
    [controller]
  );
  useLayoutEffect(() => {
    if (chatInput === localTextRef.current) return;
    localTextRef.current = chatInput;
    chatMentionRef.current = null;
    setChatMention(null);
    chatMentionDismissRef.current = null;
  }, [chatInput]);
  // A different thread's draft: its dismissed slash menu isn't this one's.
  const draftKey = draft.key;
  const previousDraftKeyRef = useRef(draftKey);
  useLayoutEffect(() => {
    if (previousDraftKeyRef.current === draftKey) return;
    previousDraftKeyRef.current = draftKey;
    chatMentionRef.current = null;
    setChatMention(null);
    chatMentionDismissRef.current = null;
    setSlashDismissedDraft(null);
  }, [draftKey]);

  // Autosize the composer to its content. The height lives as an inline style
  // on the textarea, so it is lost with the DOM node on every unmount.
  const resizeChatInput = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  // The composer unmounts whenever the shell swaps views — Settings, the Code
  // tab — and remounts with a fresh node that has no height style, collapsing a
  // long draft back to one line. Measuring from the ref callback re-applies the
  // height during the same commit that mounts the node, so the draft keeps the
  // size its text earns no matter what caused the remount.
  const setChatInputRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      chatInputRef.current = el;
      controller.setInput(el);
      resizeChatInput(el);
    },
    [controller, resizeChatInput]
  );
  useLayoutEffect(() => {
    resizeChatInput(chatInputRef.current);
  }, [chatInput, resizeChatInput]);

  const focusAt = useCallback((caret: number) => {
    requestAnimationFrame(() => {
      const el = chatInputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }, []);

  const canReferenceThreadsFromComposer = canReferenceThreads && allowsThreadMentionsInComposer(chatInput);
  // Asides, reviews, and goals skip the dispatcher that resolves @nickname
  // mentions; the embedded Claude Code terminal never loads Orion MCPs.
  const canMentionMcpsFromComposer = !isTerminalThread && allowsThreadMentionsInComposer(chatInput);

  // Composer @-mention candidates. Root level (no mode picked yet) offers the
  // Model / Thread kinds; typing there filters models directly so the
  // pre-thread-mentions muscle memory keeps working. Model mode: models on
  // enabled providers, 'orion' excluded (work can't be delegated to the
  // orchestrator itself); an empty query shows the favorites (or everything).
  // Thread mode: every thread in "Recent agents" order, searched with the same
  // scoring as the sidebar's thread search, lazy-loaded a page at a time
  // (threadMatchTotal reports the full match count so scrolling knows when to
  // fetch more). Model lists cap at 8 rows.
  const { candidates: chatMentionCandidates, threadMatchTotal: chatMentionThreadTotal } = useMemo<{
    candidates: ChatMentionCandidate[];
    threadMatchTotal: number;
  }>(() => {
    if (!chatMention) return { candidates: [], threadMatchTotal: 0 };
    const query = chatMention.query.toLowerCase();
    const mcpMatches = (limit: number) =>
      (canMentionMcpsFromComposer ? orionMcps : [])
        .filter(
          (server) =>
            !query ||
            server.nickname.includes(query) ||
            (server.detail ?? '').toLowerCase().includes(query)
        )
        .slice(0, limit)
        .map((server) => ({ kind: 'mcp' as const, server }));

    if (chatMention.mode === 'mcp') {
      return { candidates: mcpMatches(20), threadMatchTotal: 0 };
    }

    if (chatMention.mode === 'chat') {
      // Same capability gate as threads: the agent reads a mentioned chat
      // with read_chat on the same `orion` MCP server as read_thread.
      if (!canReferenceThreadsFromComposer) return { candidates: [], threadMatchTotal: 0 };
      const trimmedQuery = chatMention.query.trim();
      const search = durangoChatSearch?.query === trimmedQuery ? durangoChatSearch : null;
      const status = (message: string, action?: 'sign-in') => ({
        candidates: [{ kind: 'chatStatus' as const, message, ...(action ? { action } : {}) }],
        threadMatchTotal: 0,
      });
      if (search?.status === 'error') {
        if (search.code === 'not_signed_in') return status('Sign in to your Durango account to mention Durango chats', 'sign-in');
        if (search.code === 'not_connected') return status(`Durango Chat isn't connected: ${search.error ?? 'try again later'}`);
        return status(`Couldn't search Durango chats: ${search.error ?? 'try again later'}`);
      }
      // While a new query loads, keep showing the previous results.
      const chats = search?.status === 'ready' ? search.chats : (durangoChatSearch?.chats ?? []);
      if (chats.length === 0) {
        if (!search || search.status === 'loading') return status('Searching Durango chats…');
        return status(trimmedQuery ? `No Durango chats match "${trimmedQuery}"` : 'No Durango chats yet');
      }
      return {
        candidates: chats.map((chat) => ({ kind: 'chat' as const, chat })),
        threadMatchTotal: 0,
      };
    }

    if (chatMention.mode === 'thread') {
      // Hide unresolvable references for terminal threads and providers whose
      // installed CLI cannot receive Orion's read_thread tool.
      if (!canReferenceThreadsFromComposer) return { candidates: [], threadMatchTotal: 0 };
      const projectById = new Map(projects.map((project) => [project.id, project]));
      // The composing thread can't usefully reference itself.
      const base = threads.filter((thread) =>
        isThreadReferenceCandidate(
          thread.id,
          threadId,
          isClaudeCodeCliModelId(thread.modelId)
        )
      );
      const trimmedQuery = chatMention.query.trim();
      if (!trimmedQuery) {
        return {
          candidates: base
            .slice()
            .sort(compareRecentThreadOrder)
            .slice(0, chatMentionThreadLimit)
            .map((thread) => ({
              kind: 'thread' as const,
              thread,
              projectName: projectById.get(thread.projectId)?.name ?? 'Unknown project',
            })),
          threadMatchTotal: base.length,
        };
      }
      const parsedQuery = parseSearchQuery(trimmedQuery);
      const scored = base
        .map((thread) => {
          const project = projectById.get(thread.projectId);
          const projectName = project?.name ?? 'Unknown project';
          const entry = getThreadSearchEntry(
            thread,
            projectName,
            project?.path ?? ''
          );
          return { thread, projectName, score: scoreThreadSearchEntry(entry, parsedQuery) };
        })
        .filter((result) => result.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            getThreadActivityTime(b.thread).getTime() - getThreadActivityTime(a.thread).getTime()
        );
      return {
        candidates: scored
          .slice(0, chatMentionThreadLimit)
          .map(({ thread, projectName }) => ({ kind: 'thread' as const, thread, projectName })),
        threadMatchTotal: scored.length,
      };
    }

    const base = agentModels.filter(
      (model) =>
        model.providerId !== 'orion' &&
        // The Claude Code CLI pseudo-model is an interactive terminal, not a
        // delegable harness.
        model.id !== claudeCodeCliModelId &&
        enabledProviderIds.has(model.providerId)
    );
    const categoryAvailable = (category: ChatMentionMode) =>
      category === 'model' ||
      ((category === 'thread' || category === 'chat') && canReferenceThreadsFromComposer) ||
      (category === 'mcp' && canMentionMcpsFromComposer && orionMcps.length > 0);
    if (!query) {
      if (!chatMention.mode) {
        return {
          candidates: chatMentionCategories.filter((candidate) => categoryAvailable(candidate.category)),
          threadMatchTotal: 0,
        };
      }
      const favorites = base.filter((model) => model.favorite);
      return {
        candidates: (favorites.length > 0 ? favorites : base)
          .slice(0, 8)
          .map((model) => ({ kind: 'model' as const, model })),
        threadMatchTotal: 0,
      };
    }
    // Kind rows that prefix-match keep the root level reachable by typing
    // (e.g. "@th" highlights Thread).
    const categories = chatMention.mode
      ? []
      : chatMentionCategories.filter(
          (candidate) =>
            categoryAvailable(candidate.category) &&
            (candidate.label.toLowerCase().startsWith(query) ||
              // "@chat" reaches "Durango chats" too.
              (candidate.category === 'chat' && 'chat'.startsWith(query)))
        );
    const models = base
      .filter(
        (model) =>
          model.id.toLowerCase().includes(query) ||
          model.label.toLowerCase().includes(query) ||
          model.slug.toLowerCase().includes(query) ||
          model.providerLabel.toLowerCase().includes(query)
      )
      .slice(0, 8)
      .map((model) => ({ kind: 'model' as const, model }));
    // Typing straight after '@' also finds connected MCPs by nickname.
    const mcps = chatMention.mode ? [] : mcpMatches(4);
    return { candidates: [...categories, ...mcps, ...models], threadMatchTotal: 0 };
  }, [
    agentModels,
    canMentionMcpsFromComposer,
    canReferenceThreadsFromComposer,
    orionMcps,
    chatMention,
    chatMentionThreadLimit,
    durangoChatSearch,
    enabledProviderIds,
    projects,
    threadId,
    threads,
  ]);
  const chatMentionHasMoreThreads =
    chatMention?.mode === 'thread' && chatMentionThreadTotal > chatMentionCandidates.length;
  // @chat dropdown: search Durango as the query changes (debounced; the
  // newest query wins). Nothing is fetched until the user picks "Durango
  // chats", so composing never touches the network otherwise.
  const durangoChatQuery =
    chatMention?.mode === 'chat' && canReferenceThreadsFromComposer ? chatMention.query.trim() : null;
  useEffect(() => {
    if (durangoChatQuery === null) return;
    const query = durangoChatQuery;
    if (!window.orion?.durangoSearchChats) {
      setDurangoChatSearch({
        query,
        status: 'error',
        chats: [],
        code: 'not_connected',
        error: 'this build cannot reach Durango Chat',
      });
      return;
    }
    let active = true;
    setDurangoChatSearch((current) => ({
      query,
      status: 'loading',
      chats: current?.status === 'ready' ? current.chats : [],
    }));
    const timer = window.setTimeout(() => {
      void window.orion!.durangoSearchChats!({ query, limit: 20 }).then(
        (result) => {
          if (!active) return;
          if (result.ok) {
            rememberDurangoChats(result.data);
            setDurangoChatSearch({ query, status: 'ready', chats: result.data });
          } else {
            setDurangoChatSearch({ query, status: 'error', chats: [], code: result.code, error: result.error });
          }
        },
        () => {
          if (active) {
            setDurangoChatSearch({ query, status: 'error', chats: [], code: 'network', error: 'Durango is unreachable' });
          }
        }
      );
    }, query ? DURANGO_CHAT_SEARCH_DEBOUNCE_MS : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [durangoChatQuery]);
  // A new thread query starts back at the first page.
  const chatMentionThreadQuery = chatMention?.mode === 'thread' ? chatMention.query.trim() : null;
  useEffect(() => {
    setChatMentionThreadLimit(CHAT_MENTION_THREAD_PAGE);
  }, [chatMentionThreadQuery]);
  // Nearing the bottom of the dropdown loads the next page of threads.
  const handleChatMentionScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!chatMentionHasMoreThreads) return;
      const el = event.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
        setChatMentionThreadLimit((limit) => limit + CHAT_MENTION_THREAD_PAGE);
      }
    },
    [chatMentionHasMoreThreads]
  );
  const chatMentionOpen = Boolean(chatMention) && chatMentionCandidates.length > 0;
  // Reset the highlight to the top whenever the candidate list changes —
  // except when lazy loading merely appends thread rows, which should leave
  // the highlight (and the user's scroll position) where they are.
  const chatMentionListKey = chatMentionCandidates
    .map((candidate) =>
      candidate.kind === 'category'
        ? `category:${candidate.category}`
        : candidate.kind === 'model'
          ? `model:${candidate.model.id}`
          : candidate.kind === 'mcp'
            ? `mcp:${candidate.server.id}`
            : candidate.kind === 'chat'
              ? `chat:${candidate.chat.id}`
              : candidate.kind === 'chatStatus'
                ? `chatStatus:${candidate.message}`
                : `thread:${candidate.thread.id}`
    )
    .join('|');
  const prevChatMentionListKeyRef = useRef('');
  const chatMentionListAppendedRef = useRef(false);
  useEffect(() => {
    const prev = prevChatMentionListKeyRef.current;
    prevChatMentionListKeyRef.current = chatMentionListKey;
    const appended =
      prev !== '' && chatMentionListKey !== prev && chatMentionListKey.startsWith(`${prev}|`);
    chatMentionListAppendedRef.current = appended;
    if (!appended) setChatMentionIndex(0);
  }, [chatMentionListKey]);
  // The dropdown's height is clamped to the space around the composer, so
  // keyboard navigation has to keep the highlighted row scrolled into view.
  // Skip the scroll when rows were appended without the highlight moving
  // (wheel-driven lazy load) so the list doesn't jump back to the highlight.
  const chatMentionSelectedRef = useRef<HTMLButtonElement | null>(null);
  const prevChatMentionIndexRef = useRef(0);
  useEffect(() => {
    const indexChanged = prevChatMentionIndexRef.current !== chatMentionIndex;
    prevChatMentionIndexRef.current = chatMentionIndex;
    const appended = chatMentionListAppendedRef.current;
    chatMentionListAppendedRef.current = false;
    if (appended && !indexChanged) return;
    chatMentionSelectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [chatMentionIndex, chatMentionListKey]);

  // Slash-command menu: active while the whole draft is a single "/" token.
  // The pool is every command available in this composer context (Orion
  // natives + the project's live Claude list, seeded by a static fallback);
  // the menu shows the pool filtered by what's typed after the "/".
  const slashToken = getSlashToken(chatInput.trimStart());
  const draftStartsWithSlash = chatInput.trimStart().startsWith('/');
  const slashCommandPool = useMemo<SlashCommandCandidate[]>(() => {
    if (isNativeSubagentThread) return [];
    if (!draftStartsWithSlash) return [];
    return buildSlashCommandCandidates(
      {
        providerId,
        claudeBacked,
        isTerminal: isTerminalThread,
      },
      liveSlashCommands
    );
  }, [claudeBacked, draftStartsWithSlash, isNativeSubagentThread, isTerminalThread, liveSlashCommands, providerId]);
  const slashCommandCandidates = useMemo<SlashCommandCandidate[]>(
    () => (slashToken ? filterSlashCommands(slashCommandPool, slashToken.query) : []),
    [slashCommandPool, slashToken?.query]
  );
  // Codex's one-click /review presets outrank the generic slash menu: a bare
  // "/review" draft goes straight to the preset popover so a single click
  // dispatches the review instead of first re-completing the command.
  const codexReviewPresetsActive =
    providerId === 'codex' && !isTerminalThread && /^\/review\s*$/i.test(chatInput.trimStart());
  const slashMenuOpen =
    Boolean(slashToken) &&
    slashCommandCandidates.length > 0 &&
    chatInput !== slashDismissedDraft &&
    !codexReviewPresetsActive;
  const slashCommandListKey = slashCommandCandidates
    .map((candidate) => `${candidate.source}:${candidate.command.name}`)
    .join('|');
  useEffect(() => {
    setSlashCommandIndex(0);
  }, [slashCommandListKey]);
  const slashCommandSelectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    slashCommandSelectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [slashCommandIndex, slashCommandListKey]);
  // Argument-hint strip under the composer once a known command is completed
  // (menu closed). /review, /goal, and /btw keep their richer bespoke banners.
  const completedSlash = useMemo(() => {
    if (slashMenuOpen || slashCommandPool.length === 0) return null;
    const candidate = completedSlashCommand(chatInput.trimStart(), slashCommandPool);
    if (!candidate) return null;
    if (candidate.source === 'orion' && /^(review|goal|btw)$/.test(candidate.command.name)) {
      return null;
    }
    return candidate;
  }, [chatInput, slashCommandPool, slashMenuOpen]);

  // Track the composer's active @-mention token: the last '@' at/before the
  // caret whose preceding character is start-of-text or whitespace, with no
  // whitespace between the '@' and the caret. Thread mode is the exception:
  // its search query may contain spaces (thread titles do), so only a newline
  // ends the token there. The mode a user picked survives as long as the same
  // '@' is being edited — once the mention closes, it is gone, which is what
  // stops a completed "@thread:… " token from reopening the dropdown while
  // the rest of the message is typed.
  const updateChatMention = useCallback((value: string, caret: number | null) => {
    const prev = chatMentionRef.current;
    let next: ChatMention | null = null;
    if (caret !== null) {
      const beforeCaret = value.slice(0, caret);
      const atIndex = beforeCaret.lastIndexOf('@');
      if (atIndex !== -1) {
        const charBefore = atIndex > 0 ? beforeCaret[atIndex - 1] : '';
        const query = beforeCaret.slice(atIndex + 1);
        const mode = prev && prev.start === atIndex ? prev.mode : undefined;
        const queryAllowed =
          mode === 'thread' || mode === 'chat' ? !/[\r\n]/.test(query) : !/\s/.test(query);
        if ((!charBefore || /\s/.test(charBefore)) && queryAllowed) {
          next = { start: atIndex, query, ...(mode ? { mode } : {}) };
        }
      }
    }
    // A token dismissed with Escape stays closed until a new '@' is typed.
    if (next && chatMentionDismissRef.current === next.start) {
      next = null;
    } else {
      chatMentionDismissRef.current = null;
    }
    // Plain typing outside any token keeps the state (and this render) as is.
    if (!next && !prev) return;
    chatMentionRef.current = next;
    setChatMention(next);
  }, []);

  // Selecting a kind at the dropdown's root level clears anything typed after
  // the '@' and narrows the dropdown to that kind's list.
  const selectChatMentionCategory = (mode: ChatMentionMode) => {
    if (!chatMention) return;
    const replaceEnd = getChatMentionReplaceEnd(chatInput, chatMention, 'model');
    const nextValue = chatInput.slice(0, chatMention.start + 1) + chatInput.slice(replaceEnd);
    const caret = chatMention.start + 1;
    const next = { start: chatMention.start, query: '', mode };
    setLocalText(nextValue);
    chatMentionRef.current = next;
    setChatMention(next);
    focusAt(caret);
  };

  // Selecting a mention replaces the typed token with the model's or thread's
  // unambiguous mention token and puts the caret right after the inserted text.
  const insertChatMention = (candidate: ChatMentionCandidate | undefined) => {
    if (!chatMention || !candidate) return;
    if (candidate.kind === 'category') {
      selectChatMentionCategory(candidate.category);
      return;
    }
    if (candidate.kind === 'chatStatus') {
      if (candidate.action === 'sign-in') {
        chatMentionRef.current = null;
        setChatMention(null);
        onOpenAccountSettings();
      }
      return;
    }
    if (candidate.kind === 'chat') rememberDurangoChats([candidate.chat]);
    const inserted =
      candidate.kind === 'model'
        ? `@${modelMentionToken(candidate.model, agentModels)} `
        : candidate.kind === 'mcp'
          ? `@${candidate.server.nickname} `
          : candidate.kind === 'chat'
            ? `@${chatMentionToken(candidate.chat)} `
            : `@${threadMentionToken(candidate.thread)} `;
    // Thread and chat searches can contain spaces, so text after the caret
    // is ambiguous and must be preserved. Model mentions have a safe
    // slug-like token boundary and still consume a matching suffix.
    const replaceEnd = getChatMentionReplaceEnd(
      chatInput,
      chatMention,
      candidate.kind === 'thread' ? 'thread' : candidate.kind === 'chat' ? 'chat' : 'model'
    );
    const nextValue = chatInput.slice(0, chatMention.start) + inserted + chatInput.slice(replaceEnd);
    const caret = chatMention.start + inserted.length;
    setLocalText(nextValue);
    chatMentionRef.current = null;
    setChatMention(null);
    chatMentionDismissRef.current = null;
    setSlashDismissedDraft(null);
    focusAt(caret);
  };

  // Selecting a slash command replaces the draft with the command. Commands
  // that take arguments complete to "/name " so the user can type them;
  // argument-less ones can submit immediately (Claude Code's Enter-runs-it).
  const insertSlashCommand = (
    candidate: SlashCommandCandidate | undefined,
    options?: { submit?: boolean }
  ) => {
    if (!candidate) return;
    const hasArguments = Boolean(candidate.command.argumentHint);
    const nextValue = `/${candidate.command.name}${hasArguments ? ' ' : ''}`;
    setSlashDismissedDraft(null);
    setLocalText(nextValue);
    if (options?.submit && !hasArguments) {
      onSend(nextValue);
      return;
    }
    focusAt(nextValue.length);
  };

  // Handle chat submit: ⏎ sends (or queues mid-run), ⌘⏎ steers mid-run.
  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    // The open slash-command menu captures navigation keys first. It never
    // coexists with the @-mention dropdown: the slash token spans the whole
    // draft and contains no whitespace, so no "@" token can start inside it.
    if (slashMenuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const count = slashCommandCandidates.length;
        setSlashCommandIndex((index) => (index + delta + count) % count);
        return;
      }
      // Tab completes; Enter completes and runs argument-less commands
      // immediately. Shift+Enter keeps its newline meaning.
      if (e.key === 'Tab') {
        e.preventDefault();
        insertSlashCommand(slashCommandCandidates[slashCommandIndex] ?? slashCommandCandidates[0]);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        insertSlashCommand(slashCommandCandidates[slashCommandIndex] ?? slashCommandCandidates[0], {
          submit: true,
        });
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissedDraft(chatInput);
        return;
      }
    }
    // The open @-mention dropdown captures navigation keys first.
    if (chatMentionOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const count = chatMentionCandidates.length;
        // At the bottom with more threads unloaded, arrowing down fetches the
        // next page and steps onto its first row instead of wrapping to the top.
        if (delta === 1 && chatMentionIndex === count - 1 && chatMentionHasMoreThreads) {
          setChatMentionThreadLimit((limit) => limit + CHAT_MENTION_THREAD_PAGE);
          setChatMentionIndex(count);
          return;
        }
        setChatMentionIndex((index) => (index + delta + count) % count);
        return;
      }
      // Shift+Enter keeps its newline meaning even with the dropdown open;
      // plain Enter and Tab select the highlighted mention.
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        insertChatMention(chatMentionCandidates[chatMentionIndex] ?? chatMentionCandidates[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        chatMentionDismissRef.current = chatMention?.start ?? null;
        chatMentionRef.current = null;
        setChatMention(null);
        return;
      }
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if ((e.metaKey || e.ctrlKey) && isSending && steerReady) {
      onSteer();
      return;
    }
    onSend();
  };

  // A sidebar thread dropped on the composer links it as an @thread mention —
  // the same token the @ dropdown inserts — rather than opening a split pane.
  // Only drags the composer can turn into a working reference are intercepted;
  // anything else falls through to the panel's split-view handlers.
  const [composerThreadDropActive, setComposerThreadDropActive] = useState(false);
  const composerAcceptsThreadDrop =
    canReferenceThreadsFromComposer && !isNativeSubagentThread && !workspaceUnavailable;

  const handleComposerThreadDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isThreadDrag(event) || !composerAcceptsThreadDrop) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setComposerThreadDropActive(true);
    // The panel's split-drop hint is already up from the travel across the
    // main view; the composer takes over while the drag is above it.
    onThreadDragOver();
  };

  const handleComposerThreadDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isThreadDrag(event)) return;
    // Ignore transitions between the composer's own children.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setComposerThreadDropActive(false);
  };

  const handleComposerThreadDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isThreadDrag(event) || !composerAcceptsThreadDrop) return;
    event.preventDefault();
    event.stopPropagation();
    setComposerThreadDropActive(false);
    const droppedId = event.dataTransfer.getData(THREAD_DRAG_MIME);
    const thread = threads.find((t) => t.id === droppedId);
    if (
      !thread ||
      !isThreadReferenceCandidate(
        thread.id,
        threadId,
        isClaudeCodeCliModelId(thread.modelId)
      )
    ) {
      return;
    }
    // Insert at the caret (the textarea keeps its selection while unfocused),
    // padding with spaces so the token stays a standalone word.
    const token = `@${threadMentionToken(thread)}`;
    const el = chatInputRef.current;
    const start = el?.selectionStart ?? chatInput.length;
    const end = el?.selectionEnd ?? start;
    const before = chatInput.slice(0, start);
    const after = chatInput.slice(end);
    const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${token}${/^\s/.test(after) ? '' : ' '}`;
    setLocalText(before + inserted + after);
    chatMentionRef.current = null;
    setChatMention(null);
    chatMentionDismissRef.current = null;
    focusAt(start + inserted.length);
  };

  const removeChatAttachment = (id: string) => {
    controller.setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const reviewDraft = chatInput.trimStart();

  return (
    <div
      className={`composer-shell${composerThreadDropActive ? ' thread-drop-target' : ''}`}
      onDragOver={handleComposerThreadDragOver}
      onDragLeave={handleComposerThreadDragLeave}
      onDrop={handleComposerThreadDrop}
    >
      {chatAttachments.length > 0 && (
        <div className="composer-attachments">
          {chatAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className={`composer-attachment${attachment.snapshot?.kind === 'accessibility' ? ' cursor-pointer' : ''}`}
              title={
                attachment.snapshot?.kind === 'accessibility'
                  ? `Open the app text captured from ${attachment.snapshot.appName}\n${attachment.path}`
                  : attachment.path
              }
              onClick={
                attachment.snapshot?.kind === 'accessibility'
                  ? (event) => {
                      if ((event.target as HTMLElement).closest('button')) return;
                      void openSnapShotOutline(attachment.path);
                    }
                  : undefined
              }
            >
              <AttachmentThumb attachment={attachment} />
              <span className="composer-attachment-meta">
                {attachment.snapshot && <SnapShotAttachmentBadge snapshot={attachment.snapshot} />}
                <span className="composer-attachment-name">{attachment.name}</span>
                <span className="composer-attachment-size">
                  {formatAttachmentSize(attachment.size)}
                </span>
              </span>
              <button
                type="button"
                className="composer-attachment-remove"
                onClick={() => removeChatAttachment(attachment.id)}
                title="Remove attachment"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {taskRow}
      {mcpRow}
      {!slashMenuOpen && completedSlash && (
        <div className="composer-btw-hint">
          <SquareSlash size={12} />
          <span>
            /{completedSlash.command.name}
            {completedSlash.command.argumentHint ? ` ${completedSlash.command.argumentHint}` : ''}
            {completedSlash.command.description ? ` — ${completedSlash.command.description}` : ''}
          </span>
        </div>
      )}
      {!slashMenuOpen &&
        !isTerminalThread &&
        // Claude-backed threads run Claude Code's own /review (expanded
        // CLI-side); the generic command hint above covers it there. While
        // the preset popover is up it already explains the choices, so the
        // long banner would only stack noise above the composer.
        !claudeBacked &&
        !codexReviewPresetsActive &&
        /^\/review(\s|$)/i.test(reviewDraft) && (
          <div className="composer-btw-hint">
            <SquarePen size={12} />
            <span>
              {providerId === 'codex'
                ? 'Code review — Codex reviews uncommitted changes by default. “/review base <branch>”, “/review commit <sha>”, or “/review <custom instructions>”.'
                : '/review is only available on Codex agents.'}
            </span>
          </div>
        )}
      {!slashMenuOpen &&
        !isTerminalThread &&
        !claudeBacked &&
        /^\/goal(\s|$)/i.test(reviewDraft) && (
        <div className="composer-btw-hint">
          <Target size={12} />
          <span>
            {providerId === 'codex'
              ? 'Goal — Codex pursues it autonomously across turns until it’s achieved, blocked, or the budget runs out. “/goal <objective> [budget:500k]”, or pause / resume / clear / status.'
              : '/goal is only available on Codex agents.'}
          </span>
        </div>
      )}
      {!slashMenuOpen && !isTerminalThread && /^\/btw(\s|$)/i.test(reviewDraft) && (
        <div className="composer-btw-hint">
          <Sparkles size={12} />
          <span>
            {btwAvailable
              ? 'Aside question — answered by a read-only fork of this thread’s Claude session. It won’t interrupt the agent or join the thread.'
              : '/btw is only available on Claude agents for now.'}
          </span>
        </div>
      )}
      {codexReviewPresetsActive && (
          <ComposerPopover className="review-popover">
            <button
              type="button"
              role="option"
              className="mention-row"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                onDispatchReview('/review', {
                  mode: 'uncommitted',
                })
              }
            >
              <SquarePen size={14} />
              <span className="mention-row-label">Review uncommitted changes</span>
            </button>
            <button
              type="button"
              role="option"
              className="mention-row"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setLocalText('/review base ')}
            >
              <GitBranch size={14} />
              <span className="mention-row-label">Review against a base branch</span>
            </button>
          </ComposerPopover>
        )}
      {!slashMenuOpen &&
        providerId === 'codex' &&
        /^\/review\s+base\s*$/i.test(reviewDraft) && (
          <ComposerPopover className="review-popover">
            {reviewBranches.slice(0, 12).map((branch) => (
              <button
                key={branch}
                type="button"
                role="option"
                className="mention-row"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  onDispatchReview(`/review base ${branch}`, {
                    mode: 'base',
                    base: branch,
                  })
                }
              >
                <GitBranch size={14} />
                <span className="mention-row-label">{branch}</span>
              </button>
            ))}
            {reviewBranches.length === 0 && (
              <div className="mention-row" aria-disabled="true">
                <GitBranch size={14} />
                <span className="mention-row-label">No other branches — type a branch name</span>
              </div>
            )}
          </ComposerPopover>
        )}
      {slashMenuOpen && (
        <ComposerPopover className="slash-popover">
          {slashCommandCandidates.map((candidate, index) => {
            const { command, source } = candidate;
            const RowIcon =
              source === 'orion'
                ? command.name === 'goal'
                  ? Target
                  : command.name === 'review'
                    ? SquarePen
                    : command.name === 'btw'
                      ? Sparkles
                      : command.name === 'clear'
                        ? Eraser
                        : command.name === 'model'
                          ? Bot
                          : SquareSlash
                : SquareSlash;
            return (
              <button
                key={`${source}:${command.name}`}
                ref={index === slashCommandIndex ? slashCommandSelectedRef : null}
                type="button"
                role="option"
                aria-selected={index === slashCommandIndex}
                className={`mention-row ${index === slashCommandIndex ? 'selected' : ''}`}
                onMouseEnter={() => setSlashCommandIndex(index)}
                // Keep the textarea focused so selection doesn't blur the composer.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertSlashCommand(candidate, { submit: true })}
              >
                <RowIcon size={16} />
                <span className="mention-row-label">
                  /{command.name}
                  {command.argumentHint ? (
                    <span className="slash-row-hint"> {command.argumentHint}</span>
                  ) : null}
                </span>
                <span className="mention-row-slug">{command.description}</span>
              </button>
            );
          })}
        </ComposerPopover>
      )}
      {chatMentionOpen && (
        <ComposerPopover onScroll={handleChatMentionScroll}>
          {chatMentionCandidates.map((candidate, index) => {
            const rowProps = {
              ref: index === chatMentionIndex ? chatMentionSelectedRef : null,
              type: 'button' as const,
              role: 'option',
              'aria-selected': index === chatMentionIndex,
              className: `mention-row ${index === chatMentionIndex ? 'selected' : ''}`,
              onMouseEnter: () => setChatMentionIndex(index),
              // Keep the textarea focused so selection doesn't blur the composer.
              onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
              onClick: () => insertChatMention(candidate),
            };
            if (candidate.kind === 'category') {
              const CategoryIcon =
                candidate.category === 'model'
                  ? Bot
                  : candidate.category === 'mcp'
                    ? Plug
                    : candidate.category === 'chat'
                      ? MessageCircle
                      : MessageSquare;
              return (
                <button key={`category:${candidate.category}`} {...rowProps} title={candidate.hint}>
                  <CategoryIcon size={16} />
                  <span className="mention-row-label">{candidate.label}</span>
                  <span className="mention-row-slug">{candidate.hint}</span>
                </button>
              );
            }
            if (candidate.kind === 'thread') {
              const { thread, projectName } = candidate;
              return (
                <button key={thread.id} {...rowProps} title={threadMentionToken(thread)}>
                  <MessageSquare size={16} />
                  <span className="mention-row-label">{thread.title}</span>
                  <span className="mention-row-slug">
                    {projectName} · {formatShortTime(getThreadActivityTime(thread))}
                  </span>
                </button>
              );
            }
            if (candidate.kind === 'chat') {
              const { chat } = candidate;
              const updated = formatChatUpdatedAt(chat.updatedAt);
              const snippet = chat.snippet?.trim().replace(/\s+/g, ' ') ?? '';
              return (
                <button
                  key={`chat:${chat.id}`}
                  {...rowProps}
                  className={`${rowProps.className} chat-mention-row`}
                  title={`@${chatMentionToken(chat)}`}
                >
                  <MessageCircle size={16} />
                  <span className="mention-row-label">{chat.title || 'Untitled chat'}</span>
                  <span className="mention-row-slug">
                    {[updated, snippet].filter(Boolean).join(' · ') || 'Durango chat'}
                  </span>
                </button>
              );
            }
            if (candidate.kind === 'chatStatus') {
              return (
                <button
                  key={`chatStatus:${candidate.message}`}
                  {...rowProps}
                  aria-disabled={!candidate.action}
                  title={candidate.action === 'sign-in' ? 'Open account settings' : candidate.message}
                >
                  <MessageCircle size={16} />
                  <span className="mention-row-slug">{candidate.message}</span>
                </button>
              );
            }
            if (candidate.kind === 'mcp') {
              const { server } = candidate;
              return (
                <button key={`mcp:${server.id}`} {...rowProps} title={`@${server.nickname}`}>
                  <Plug size={16} />
                  <span className="mention-row-label">@{server.nickname}</span>
                  <span className="mention-row-slug">
                    {server.status === 'needs-sign-in'
                      ? 'sign in needed'
                      : server.enabled
                        ? 'always on'
                        : 'MCP · loads when mentioned'}
                  </span>
                </button>
              );
            }
            const { model } = candidate;
            const ProviderIcon =
              agentProviders.find((provider) => provider.id === model.providerId)?.icon ?? Play;
            return (
              <button key={model.id} {...rowProps} title={modelMentionToken(model, agentModels)}>
                <ProviderIcon size={16} />
                <span className="mention-row-label">{model.label}</span>
                <span className="mention-row-slug">{modelMentionToken(model, agentModels)}</span>
              </button>
            );
          })}
        </ComposerPopover>
      )}
      <textarea
        ref={setChatInputRef}
        className="chat-input min-h-[52px]"
        disabled={isNativeSubagentThread || workspaceUnavailable}
        placeholder={
          isNativeSubagentThread
            ? 'Read-only subagent transcript — steer from the parent thread.'
            : workspaceUnavailable
              ? workspaceRemoving
                ? 'Removing this thread’s Durango workspace…'
                : 'Creating a Durango workspace for this thread — cloning dependencies, one moment…'
              : isTerminalThread
                ? 'Type a prompt — ⏎ sends it to the Claude Code terminal…'
                : isSending
                  ? steerSupported
                    ? 'Queue a follow-up (⏎) or steer the agent now (⌘⏎)…'
                    : 'Queue a follow-up — sends when the agent finishes (⏎)…'
                  : starting
                    ? 'Starting the agent…'
                    : chatAttachments.length > 0
                      ? `Ask something about the attached ${attachmentKindLabel(chatAttachments)}...`
                      : hasPendingLinkedTasks
                        ? `Add details (optional) — send starts on the linked ${
                            pendingLinkedTaskCount > 1 ? 'tasks' : 'task'
                          }...`
                        : 'Describe what you want the agent to do...'
        }
        value={chatInput}
        onChange={(e) => {
          setSlashDismissedDraft(null);
          setLocalText(e.target.value);
          updateChatMention(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={handleChatKeyDown}
        // Caret moves without input still open/close the mention
        // dropdown. Dropdown-navigation keys are excluded so a
        // handled keydown can't immediately recompute the token.
        onKeyUp={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            updateChatMention(e.currentTarget.value, e.currentTarget.selectionStart);
          }
        }}
        onClick={(e) => updateChatMention(e.currentTarget.value, e.currentTarget.selectionStart)}
        rows={2}
      />
      <div className={controlsClassName} ref={controlsRef}>
        {children}
        {isSending ? (
          <>
            {hasDraftContent && (
              <>
                <button
                  className="send-button"
                  onClick={() => onSend()}
                  title="Queue — sends when the current run finishes (⏎)"
                >
                  <ListPlus size={15} />
                </button>
                {steerSupported && (
                  <button
                    className="send-button steer"
                    onClick={() => onSteer()}
                    disabled={!steerReady}
                    title={
                      steerReady
                        ? 'Steer — the agent picks this up mid-run without losing its work (⌘⏎)'
                        : 'Steer is unavailable — the message will queue instead'
                    }
                  >
                    <Zap size={14} />
                  </button>
                )}
              </>
            )}
            <button className="send-button stop" onClick={() => onStop()} title="Stop agent">
              <Square size={14} fill="currentColor" />
            </button>
          </>
        ) : (
          <button
            className="send-button"
            onClick={() => onSend()}
            disabled={starting || (!hasDraftContent && !hasPendingLinkedTasks) || !modelAvailable}
            title={starting ? 'Starting the agent…' : 'Send'}
          >
            <ArrowUp size={16} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
};
