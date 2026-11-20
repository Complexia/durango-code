import React, { createContext, useEffect, useSyncExternalStore } from 'react';
import { GitMerge, GitPullRequest, GitPullRequestClosed, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { type Thread, useOrionStore } from '../store';
import { resolveThreadReference } from './promptContext';

// Changes and threads in bot replies and agents' thread messages, shown as
// links with their titles. Bots and agents write a Durango Source change as
// its id (`chg_…`) and a Durango Code thread as `@thread:<id>` or its bare id;
// in their messages (MarkdownContent / StreamingMarkdownContent `refLinks`) each becomes a chip
// with the title: a thread this computer has (also another machine's,
// mirrored here) opens in the usual thread view, a change opens its page.
// Titles of changes, and of threads that live on another computer, come from
// Durango (bots:refs → GET /api/v1/bots/refs) in batches. An id nobody can
// resolve stays the text the bot wrote. Durango's copy (the web):
// chat/andromedus/lib/bots/refs.ts and components/bots/ref-links.tsx.

export type BotChangeRef = { title: string; status: string; url: string };
export type BotThreadRef = { title: string };
export type BotRefs = { changes: Record<string, BotChangeRef>; threads: Record<string, BotThreadRef> };
export type BotRefKind = 'change' | 'thread';
export type BotRefMatch = { kind: BotRefKind; id: string; start: number; text: string };

const CHANGE_ID = /^chg_[a-z0-9]{8,40}$/;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REFS_MAX = 50;

/** Markdown inside a bot reply: `@thread:` links there resolve through Durango too (BotRefLink). */
export const BotRefsContext = createContext(false);

// --- Finding them ---------------------------------------------------------------

/**
 * `@thread:<id>`, a change id, or a bare UUID (thread ids are UUIDs), standing
 * alone as a whole token (`See:@thread:<id>` counts, as it always did for
 * @thread): not inside a path (`/` or `\`), URL, file name
 * (`chg_….md`) or longer word, and never part of one. A bare UUID only
 * becomes a link when it is a thread. In bot replies this is the only matcher
 * for `@thread:` (markdown.tsx runs the older plugin for `@chat:` only there).
 */
const REF_PATTERN =
  /(?:(?<![A-Za-z0-9._/\\-])@thread:([A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)|(?<![\w./\\:@-])(chg_[a-z0-9]{8,40})|(?<![\w./\\:@-])([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}))(?![\w/\\-]|\.\w)/g;

export const findBotRefs = (text: string): BotRefMatch[] => {
  if (!text.includes('@thread:') && !text.includes('chg_') && !text.includes('-')) return [];
  const matches: BotRefMatch[] = [];
  for (const match of text.matchAll(REF_PATTERN)) {
    const start = match.index ?? 0;
    if (match[1] && THREAD_ID.test(match[1])) matches.push({ kind: 'thread', id: match[1], start, text: match[0] });
    else if (match[2]) matches.push({ kind: 'change', id: match[2], start, text: match[0] });
    else if (match[3]) matches.push({ kind: 'thread', id: match[3].toLowerCase(), start, text: match[0] });
  }
  return matches;
};

const HREF_PREFIX = '#durango-ref:';
const refHref = (ref: Pick<BotRefMatch, 'kind' | 'id'>) => `${HREF_PREFIX}${ref.kind}:${encodeURIComponent(ref.id)}`;

/** The ref a link made by remarkBotRefs points at, else null. */
export const parseBotRefHref = (href: string | undefined): { kind: BotRefKind; id: string } | null => {
  if (!href?.startsWith(HREF_PREFIX)) return null;
  const rest = href.slice(HREF_PREFIX.length);
  const colon = rest.indexOf(':');
  const kind = rest.slice(0, colon);
  let id = '';
  try {
    id = decodeURIComponent(rest.slice(colon + 1));
  } catch {
    return null;
  }
  if (kind === 'change' && CHANGE_ID.test(id)) return { kind, id };
  if (kind === 'thread' && THREAD_ID.test(id)) return { kind, id };
  return null;
};

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

const refLink = (ref: BotRefMatch, children: MdNode[]): MdNode => ({ type: 'link', url: refHref(ref), children });

const linkRefs = (node: MdNode) => {
  // Text already in a link (also @thread links made before this plugin) keeps it.
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === 'text' && child.value) {
      const refs = findBotRefs(child.value);
      if (!refs.length) return [child];
      const out: MdNode[] = [];
      let last = 0;
      for (const ref of refs) {
        if (ref.start > last) out.push({ type: 'text', value: child.value.slice(last, ref.start) });
        out.push(refLink(ref, [{ type: 'text', value: ref.text }]));
        last = ref.start + ref.text.length;
      }
      if (last < child.value.length) out.push({ type: 'text', value: child.value.slice(last) });
      return out;
    }
    if (child.type === 'link' && child.url) {
      // A markdown link to a ref, `[name](@thread:<id>)` or `[name](chg_…)`: react-markdown
      // would drop that target (not a URL), leaving text you can't click. It keeps its label.
      const refs = findBotRefs(child.url.trim());
      if (refs.length === 1 && refs[0].text === child.url.trim()) return [{ ...child, url: refHref(refs[0]) }];
      return [child];
    }
    if (child.type === 'inlineCode' && child.value) {
      // Only a code span that is exactly one ref.
      const value = child.value.trim();
      const refs = findBotRefs(value);
      return refs.length === 1 && refs[0].text === value ? [refLink(refs[0], [child])] : [child];
    }
    linkRefs(child);
    return [child];
  });
};

/** Remark plugin for bot replies: refs in prose and lone refs in code spans become ref links. */
export const remarkBotRefs = () => (tree: MdNode) => linkRefs(tree);

// --- Titles from Durango: batched, kept for a while -----------------------------

type Entry = { value: BotChangeRef | BotThreadRef | null; expiresAt: number };
/** How long answers are kept; tests shorten these. */
export const botRefTiming = {
  foundTtlMs: 10 * 60_000,
  // Not found (yet: a thread that hasn't synced), signed out, or the lookup failed.
  missingTtlMs: 2 * 60_000,
  // Long enough that an id still streaming in (`chg_abcd…`) is replaced on
  // screen before its batch goes out, so it is never asked for (flush).
  batchDelayMs: 120,
  // At most one revalidation round this often, whatever expires.
  minRevalidateDelayMs: 5_000,
};

const entries = new Map<string, Entry>();
const queued = new Set<string>();
const inFlight = new Set<string>();
/** Refs asked for outright (requestBotRef), not by a link on screen. */
const requested = new Set<string>();
const listeners = new Set<() => void>();
/** Refs on screen (key → mounted links), asked again when their title expires. */
const active = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let revalidateTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => {
  for (const listener of listeners) listener();
};

/** Forgets every title (another account signed in). */
export const clearBotRefs = () => {
  generation += 1;
  entries.clear();
  queued.clear();
  inFlight.clear();
  requested.clear();
  notify();
};

/** Asks Durango for a ref's title (batched with the others asked for now). */
export const requestBotRef = (kind: BotRefKind, id: string) => {
  requested.add(`${kind}:${id}`);
  request(`${kind}:${id}`);
};

const request = (key: string) => {
  const entry = entries.get(key);
  if ((entry && entry.expiresAt > Date.now()) || inFlight.has(key)) return;
  queued.add(key);
  timer ??= setTimeout(() => void flush(), botRefTiming.batchDelayMs);
};

/** The ref in an answer, only when Durango named it with a usable title (never an inherited property like `constructor`). */
export const botRefFromAnswer = (refs: Partial<BotRefs> | null, kind: BotRefKind, id: string): BotChangeRef | BotThreadRef | null => {
  const group = kind === 'change' ? refs?.changes : refs?.threads;
  if (!group || typeof group !== 'object' || !Object.hasOwn(group, id)) return null;
  const value = (group as Record<string, unknown>)[id] as Partial<BotChangeRef> | null;
  if (!value || typeof value !== 'object' || typeof value.title !== 'string' || !value.title.trim()) return null;
  if (kind === 'change' && (typeof value.url !== 'string' || typeof value.status !== 'string')) return null;
  return value as BotChangeRef | BotThreadRef;
};

const flush = async () => {
  timer = null;
  const ask = { change: [] as string[], thread: [] as string[] };
  for (const key of queued) {
    // No longer on screen (an id that was still streaming in, a message scrolled away): not asked for.
    if (!active.has(key) && !requested.has(key)) {
      queued.delete(key);
      continue;
    }
    const [kind, id] = [key.slice(0, 6), key.slice(7)] as [BotRefKind, string];
    // Past REFS_MAX it waits for the next batch (still marked if it was asked for outright).
    if (ask[kind].length < REFS_MAX) {
      ask[kind].push(id);
      queued.delete(key);
      requested.delete(key);
      inFlight.add(key);
    }
  }
  if (!ask.change.length && !ask.thread.length) return;
  const asked = generation;
  let refs: Partial<BotRefs> | null = null;
  try {
    const result = await window.orion?.botRefs?.({ changes: ask.change, threads: ask.thread });
    refs = result?.ok ? result : null;
  } catch {
    refs = null;
  }
  if (asked !== generation) return;
  const now = Date.now();
  for (const kind of ['change', 'thread'] as const) {
    for (const id of ask[kind]) {
      const key = `${kind}:${id}`;
      inFlight.delete(key);
      // A failed lookup keeps what was shown; an answer replaces it (a miss turns the chip back into text).
      const value = refs ? botRefFromAnswer(refs, kind, id) : (entries.get(key)?.value ?? null);
      entries.set(key, { value, expiresAt: now + (refs && value ? botRefTiming.foundTtlMs : botRefTiming.missingTtlMs) });
    }
  }
  notify();
  if (queued.size) timer ??= setTimeout(() => void flush(), botRefTiming.batchDelayMs);
  scheduleRevalidate();
};

// Refs on screen are asked again when they expire (another computer's thread
// that synced after a miss, a change that merged): one timer for the earliest
// expiry, and none while the window is hidden.
const scheduleRevalidate = () => {
  if (revalidateTimer) clearTimeout(revalidateTimer);
  revalidateTimer = null;
  let next = Infinity;
  for (const key of active.keys()) {
    const entry = entries.get(key);
    if (entry && !inFlight.has(key)) next = Math.min(next, entry.expiresAt);
  }
  if (next === Infinity) return;
  revalidateTimer = setTimeout(revalidate, Math.max(botRefTiming.minRevalidateDelayMs, next - Date.now()));
};

const revalidate = () => {
  revalidateTimer = null;
  if (typeof document !== 'undefined' && document.hidden) {
    document.addEventListener('visibilitychange', revalidate, { once: true });
    return;
  }
  for (const key of active.keys()) request(key);
  scheduleRevalidate();
};

/** A ref on screen: its title is asked for now and again whenever it expires. Returns the unwatch. */
export const watchBotRef = (kind: BotRefKind, id: string) => {
  const key = `${kind}:${id}`;
  active.set(key, (active.get(key) ?? 0) + 1);
  request(key);
  scheduleRevalidate();
  return () => {
    const count = (active.get(key) ?? 1) - 1;
    if (count > 0) active.set(key, count);
    else active.delete(key);
    if (!active.size && revalidateTimer) {
      clearTimeout(revalidateTimer);
      revalidateTimer = null;
    }
  };
};

/** The title known for a ref now (null while unknown, not the account's, or signed out). */
export const readBotRef = (kind: BotRefKind, id: string) => entries.get(`${kind}:${id}`)?.value ?? null;

/** A ref's title from Durango (null while unknown); `ask` false skips the lookup. */
const useDurangoRef = (kind: BotRefKind, id: string, ask: boolean) => {
  // Asked again after clearBotRefs (another account).
  const cleared = useSyncExternalStore(subscribe, () => generation, () => generation);
  useEffect(() => (ask ? watchBotRef(kind, id) : undefined), [ask, kind, id, cleared]);
  const snapshot = () => (ask ? readBotRef(kind, id) : null);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
};

// --- Opening --------------------------------------------------------------------

const resolvedThreads = new WeakMap<Thread[], Map<string, Thread | undefined>>();
const localThread = (reference: string, threads: Thread[]) => {
  let resolved = resolvedThreads.get(threads);
  if (!resolved) {
    resolved = new Map();
    resolvedThreads.set(threads, resolved);
  }
  if (!resolved.has(reference)) resolved.set(reference, resolveThreadReference(reference, threads));
  return resolved.get(reference);
};

/**
 * The thread an `orion://thread/<id>` link names: this computer's thread with
 * exactly that id, else the one mirrored thread whose id on its own machine is
 * exactly that. Never a mention-token fragment or a title (an unknown id must
 * not open a different thread).
 */
export const threadForLink = (id: string, threads: Thread[]) => {
  const wanted = id.toLowerCase();
  const own = threads.find((thread) => thread.id.toLowerCase() === wanted);
  if (own) return own;
  const mirrored = threads.filter((thread) => thread.remote?.threadId?.toLowerCase() === wanted);
  return mirrored.length === 1 ? mirrored[0] : undefined;
};

/**
 * Opens a thread this computer has in the usual thread view; false when it
 * isn't here. By default `reference` is what a reply wrote (id, mention token,
 * or another machine's id for a mirrored one); `exact` takes only the ids
 * threadForLink takes. In the Bots tab the thread shows where the bot's thread
 * was, like a reply's Open thread button.
 */
export const openThreadHere = (reference: string, { split = false, exact = false } = {}) => {
  const store = useOrionStore.getState();
  const thread = exact ? threadForLink(reference, store.threads) : localThread(reference, store.threads);
  if (!thread) return false;
  if (split) store.openThreadInSplit(thread.id);
  else store.selectThread(thread.id);
  store.setSettingsOpen(false);
  store.setActiveTab('agents');
  if (store.sidebarTab === 'bots') store.setSidebarV3Settings({ view: 'thread', threadFromProjectId: null });
  return true;
};

// --- Links ----------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = { open: 'Open', queued: 'Landing', landed: 'Merged', archived: 'Archived', abandoned: 'Abandoned' };

const stop = (event: React.MouseEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

const ThreadRefLink: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
  const thread = useOrionStore((state) => localThread(id, state.threads));
  // Another computer's thread (not mirrored here): its title from Durango (synced threads, by exact id).
  const elsewhere = useDurangoRef('thread', id, !thread);
  if (thread) {
    const title = thread.title?.trim();
    return (
      <button
        type="button"
        className="thread-reference"
        onClick={(event) => {
          stop(event);
          openThreadHere(thread.id, { split: event.metaKey || event.ctrlKey });
        }}
        title={`Open thread${title ? ` "${title}"` : ''} (⌘/Ctrl-click opens it in a split)`}
      >
        <MessageSquare size={12} aria-hidden />
        <span>{title || children}</span>
      </button>
    );
  }
  if (elsewhere) {
    return (
      <span className="thread-reference is-elsewhere" title={`"${elsewhere.title}" is on another computer`}>
        <MessageSquare size={12} aria-hidden />
        <span>{elsewhere.title}</span>
      </span>
    );
  }
  return <>{children}</>;
};

const ChangeRefLink: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
  const change = useDurangoRef('change', id, true) as BotChangeRef | null;
  if (!change) return <>{children}</>;
  const Icon = change.status === 'landed' ? GitMerge : change.status === 'archived' || change.status === 'abandoned' ? GitPullRequestClosed : GitPullRequest;
  return (
    <button
      type="button"
      className="thread-reference change-reference"
      onClick={(event) => {
        stop(event);
        void window.orion?.openBotChange?.({ changeId: id, url: change.url }).then((result) => {
          if (result && !result.ok) toast.error(result.error ?? 'Could not open the change.');
        });
      }}
      title={`${id} · ${STATUS_LABEL[change.status] ?? change.status} · open its page`}
    >
      <Icon size={12} aria-hidden />
      <span>{change.title}</span>
    </button>
  );
};

/** A change or thread a bot reply names, labelled with its title; the text the bot wrote while unknown. */
export const BotRefLink: React.FC<{ kind: BotRefKind; id: string; children: React.ReactNode }> = ({ kind, id, children }) =>
  kind === 'change' ? <ChangeRefLink id={id}>{children}</ChangeRefLink> : <ThreadRefLink id={id}>{children}</ThreadRefLink>;
