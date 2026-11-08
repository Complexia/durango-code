import React, { useDeferredValue, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MessageSquare, Search } from 'lucide-react';
import { type Message, type Project, type Thread, type ThreadTranscript, useOrionStore } from '../store';
import {
  BODY_MATCH_WORD,
  isWordStart,
  messageSearchText,
  normalizeSearchText,
  scoreBodyToken,
  transcriptExcerpt,
} from '../thread-shell.js';
import { ProjectIcon } from './ProjectIcon';
import { formatShortTime, getThreadActivityTime } from './time';

export { normalizeSearchText };

export const THREAD_SEARCH_INDEX_REFRESH_MS = 150;

const RECENT_THREAD_LIMIT = 12;
const RESULT_LIMIT = 50;
const THREAD_RESULT_LIMIT = 40;

export type SearchQuery = {
  /** Distinct normalized words; every one must match for a result to count. */
  tokens: string[];
  /** The whole normalized query, rewarded when it appears verbatim. */
  phrase: string;
};

export const parseSearchQuery = (query: string): SearchQuery => {
  const phrase = normalizeSearchText(query);
  return { phrase, tokens: Array.from(new Set(phrase.split(' ').filter(Boolean))) };
};

/**
 * Loose match for short names only: the token's first letter must start a
 * word, later letters either follow on directly or start later words, so
 * "ors" finds "orion search" but not arbitrary letters scattered through text.
 */
const fuzzyNameScore = (name: string, token: string) => {
  if (token.length < 2 || name.length > 160) return 0;
  const first = token[0];
  let best = 0;
  for (let start = name.indexOf(first); start !== -1; start = name.indexOf(first, start + 1)) {
    if (!isWordStart(name, start)) continue;
    let score = 0;
    let last = start;
    let matched = true;
    for (let i = 1; i < token.length; i += 1) {
      const char = token[i];
      if (name[last + 1] === char) {
        score += 3;
        last += 1;
        continue;
      }
      let next = name.indexOf(char, last + 1);
      while (next !== -1 && !isWordStart(name, next)) next = name.indexOf(char, next + 1);
      if (next === -1) {
        matched = false;
        break;
      }
      score += 2;
      last = next;
    }
    if (matched) best = Math.max(best, score / (3 * (token.length - 1)));
  }
  return best >= 0.5 ? Math.round(12 + 23 * best) : 0;
};

/** How well one query token matches a short name (title, project): 0–100. */
const scoreNameToken = (name: string, token: string) => {
  if (!name) return 0;
  if (name === token) return 100;
  if (name.startsWith(token)) return 85;
  let index = name.indexOf(token);
  let substring = false;
  while (index !== -1) {
    if (isWordStart(name, index)) return 70;
    substring = true;
    index = name.indexOf(token, index + 1);
  }
  // A single letter inside a word says nothing about intent.
  if (substring && token.length > 1) return 45;
  return fuzzyNameScore(name, token);
};

const recencyBonus = (activityMs: number) => {
  if (!Number.isFinite(activityMs)) return 0;
  const ageHours = Math.max(0, (Date.now() - activityMs) / (1000 * 60 * 60));
  return Math.max(0, 8 - Math.log2(ageHours + 1));
};

// Normalized transcript text per message. Messages are replaced, never
// mutated, so a streaming reply re-normalizes only the message that changed
// and every other message is reused across threads updates and reopenings.
const messageTextCache = new WeakMap<Message, string>();
const normalizedMessageText = (message: Message) => {
  let text = messageTextCache.get(message);
  if (text === undefined) {
    text = messageSearchText(message);
    messageTextCache.set(message, text);
  }
  return text;
};

// ---------------------------------------------------------------------------
// Transcripts the renderer hasn't loaded are searched in main, against the
// stored copies (thread-storage.js searchThreadBodies). Scores arrive per
// query token and are kept briefly; a revision tells searches to re-score.

const REMOTE_SCORES_TTL_MS = 30_000;
type RemoteTokenScores = { fetchedAt: number; scores: Map<string, number> };
const remoteBodyScores = new Map<string, RemoteTokenScores>();
// The tokens each open search still wants, by search, and the request in
// flight. Main runs one scan at a time and a newer request supersedes the one
// in flight, so every request carries every token any open search still
// lacks, not just the new ones: a superseded request's tokens that still
// matter are always in the request that replaced it, and nothing has to be
// asked again (or could loop).
const activeSearchTokens = new Map<string, readonly string[]>();
let remoteBodyRequest: { tokens: ReadonlySet<string> } | null = null;
const remoteExcerpts = new Map<string, string | null>();
const remoteExcerptsPending = new Set<string>();
let remoteRevision = 0;
const remoteListeners = new Set<() => void>();
const bumpRemoteRevision = () => {
  remoteRevision += 1;
  for (const listener of [...remoteListeners]) listener();
};
const subscribeRemote = (listener: () => void) => {
  remoteListeners.add(listener);
  return () => {
    remoteListeners.delete(listener);
  };
};

const fresh = (entry: RemoteTokenScores | undefined) =>
  Boolean(entry && Date.now() - entry.fetchedAt < REMOTE_SCORES_TTL_MS);

const missingRemoteTokens = () => {
  const missing = new Set<string>();
  for (const tokens of activeSearchTokens.values()) {
    // Main doesn't score tokens over 200 characters (a pasted path or URL).
    for (const token of tokens) {
      if (token.length >= 2 && token.length <= 200 && !fresh(remoteBodyScores.get(token))) missing.add(token);
    }
  }
  return [...missing];
};

const sendRemoteBodyRequest = (retryIfSupersededElsewhere = true) => {
  const wanted = missingRemoteTokens();
  if (wanted.length === 0 || typeof window === 'undefined' || !window.orion?.searchThreads) return;
  // The request in flight already asks for all of them.
  if (remoteBodyRequest && wanted.every((token) => remoteBodyRequest!.tokens.has(token))) return;
  const request = { tokens: new Set(wanted) };
  remoteBodyRequest = request;
  void window.orion
    .searchThreads({ tokens: wanted })
    .then((result) => {
      if (!result?.ok || !result.scores) {
        // Superseded by a scan this renderer didn't ask for (only possible
        // when it is still the newest request): ask once more.
        if (result && 'superseded' in result && remoteBodyRequest === request && retryIfSupersededElsewhere) {
          remoteBodyRequest = null;
          sendRemoteBodyRequest(false);
        }
        return;
      }
      // Scores are aligned with the tokens main actually scored (it skips
      // over-long ones and keeps at most 16): record those, and nothing — not
      // even "no match" — for tokens it didn't score.
      const scored = Array.isArray(result.tokens) ? result.tokens.filter((token) => request.tokens.has(token)) : [];
      const fetchedAt = Date.now();
      const byToken = scored.map(() => new Map<string, number>());
      const position = new Map((result.tokens ?? []).map((token, index) => [token, index]));
      for (const [threadId, scores] of Object.entries(result.scores)) {
        scored.forEach((token, index) => {
          const score = scores[position.get(token)!];
          if (score > 0) byToken[index].set(threadId, score);
        });
      }
      scored.forEach((token, index) => remoteBodyScores.set(token, { fetchedAt, scores: byToken[index] }));
      bumpRemoteRevision();
    })
    .catch(() => {})
    .finally(() => {
      if (remoteBodyRequest === request) remoteBodyRequest = null;
    });
};

/**
 * The transcript scores search `searchId` needs for `tokens`, asked of main
 * for any it hasn't answered recently (together with what other open
 * searches still lack).
 */
export const requestRemoteBodyScores = (tokens: readonly string[], searchId = 'default') => {
  activeSearchTokens.set(searchId, tokens);
  sendRemoteBodyRequest();
};

/** A search that closed no longer needs its tokens. */
export const releaseRemoteBodyScores = (searchId = 'default') => {
  activeSearchTokens.delete(searchId);
};

const excerptKey = (threadId: string, tokens: readonly string[]) => `${threadId}\u0000${tokens.join(' ')}`;

/** Ask main for search-result excerpts of threads whose transcript isn't loaded. */
export const requestRemoteExcerpts = (items: Array<{ threadId: string; tokens: string[] }>) => {
  const wanted = items.filter((item) => {
    const key = excerptKey(item.threadId, item.tokens);
    return !remoteExcerpts.has(key) && !remoteExcerptsPending.has(key);
  });
  if (wanted.length === 0 || typeof window === 'undefined' || !window.orion?.threadSearchExcerpts) return;
  const keys = wanted.map((item) => excerptKey(item.threadId, item.tokens));
  for (const key of keys) remoteExcerptsPending.add(key);
  void window.orion
    .threadSearchExcerpts({ items: wanted.map((item) => ({ id: item.threadId, tokens: item.tokens })) })
    .then((result) => {
      if (!result?.ok || !result.excerpts) return;
      wanted.forEach((item, index) => remoteExcerpts.set(keys[index], result.excerpts![item.threadId] ?? null));
      // Bounded: excerpts are only for what a result list shows.
      while (remoteExcerpts.size > 500) remoteExcerpts.delete(remoteExcerpts.keys().next().value!);
      bumpRemoteRevision();
    })
    .catch(() => {})
    .finally(() => {
      for (const key of keys) remoteExcerptsPending.delete(key);
    });
};

/**
 * Re-renders when main answers a transcript search, and asks it about
 * `tokens`. Searches pass the result to their memos so they re-score.
 */
export const useRemoteThreadSearch = (tokens: readonly string[]) => {
  const revision = useSyncExternalStore(subscribeRemote, () => remoteRevision, () => remoteRevision);
  const searchId = useId();
  const key = tokens.join(' ');
  useEffect(() => {
    requestRemoteBodyScores(tokens, searchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, searchId]);
  useEffect(() => () => releaseRemoteBodyScores(searchId), [searchId]);
  return revision;
};

export type ThreadSearchEntry = {
  thread: Thread;
  projectName: string;
  projectPath: string;
  title: string;
  project: string;
  /** Path, model and status: matched like transcript text, at half weight. */
  meta: string;
  /** The loaded transcript's messages, when it is loaded. */
  messages: Message[] | null;
  /**
   * Normalized text per message, index-aligned with `messages`. Null when the
   * transcript isn't loaded: main scores it then (requestRemoteBodyScores).
   */
  body: string[] | null;
};

type CachedThreadSearchEntry = {
  projectName: string;
  projectPath: string;
  transcript: ThreadTranscript | undefined;
  entry: ThreadSearchEntry;
};

// Shared by every search surface (sidebar, composer @-mentions) and kept
// across opens, so an unchanged thread is never indexed twice.
const threadEntryCache = new WeakMap<Thread, CachedThreadSearchEntry>();

// Recent results need metadata and one excerpt, not a transcript index.
const buildThreadSearchSummary = (
  thread: Thread,
  projectName: string,
  projectPath: string
): ThreadSearchEntry => ({
  thread,
  projectName,
  projectPath,
  title: normalizeSearchText(thread.title),
  project: normalizeSearchText(projectName),
  meta: normalizeSearchText(`${projectPath} ${thread.modelId} ${thread.status}`),
  messages: useOrionStore.getState().transcripts?.[thread.id]?.messages ?? null,
  body: null,
});

export const getThreadSearchEntry = (
  thread: Thread,
  projectName: string,
  projectPath: string
): ThreadSearchEntry => {
  const transcript = useOrionStore.getState().transcripts?.[thread.id];
  const cached = threadEntryCache.get(thread);
  if (
    cached &&
    cached.projectName === projectName &&
    cached.projectPath === projectPath &&
    cached.transcript === transcript
  ) {
    return cached.entry;
  }
  const entry: ThreadSearchEntry = {
    ...buildThreadSearchSummary(thread, projectName, projectPath),
    messages: transcript?.messages ?? null,
    body: transcript ? transcript.messages.map(normalizedMessageText) : null,
  };
  threadEntryCache.set(thread, { projectName, projectPath, transcript, entry });
  return entry;
};

// A loaded transcript is scored here (it may hold unsaved output); any other
// from main's answer, 0 until it arrives.
const bodyTokenScore = (entry: ThreadSearchEntry, token: string) => {
  if (entry.body) return scoreBodyToken(entry.body, token);
  return remoteBodyScores.get(token)?.scores.get(entry.thread.id) ?? 0;
};

export const scoreThreadSearchEntry = (entry: ThreadSearchEntry, query: string | SearchQuery) => {
  const { tokens, phrase } = typeof query === 'string' ? parseSearchQuery(query) : query;
  if (tokens.length === 0) return 0;

  let score = 0;
  for (const token of tokens) {
    let best = Math.max(
      scoreNameToken(entry.title, token),
      scoreNameToken(entry.project, token) * 0.4
    );
    if (best < BODY_MATCH_WORD) {
      best = Math.max(best, bodyTokenScore(entry, token), scoreBodyToken([entry.meta], token) * 0.5);
    }
    // Every word has to land somewhere, or the thread isn't a match.
    if (best === 0) return 0;
    score += best;
  }
  if (tokens.length > 1 && entry.title.includes(phrase)) score += 40;
  return score + recencyBonus(getThreadActivityTime(entry.thread).getTime());
};

export const compareThreadSearchResults = (
  a: { score: number; entry: ThreadSearchEntry },
  b: { score: number; entry: ThreadSearchEntry }
) => b.score - a.score ||
  getThreadActivityTime(b.entry.thread).getTime() - getThreadActivityTime(a.entry.thread).getTime();

type ProjectSearchEntry = { project: Project; name: string; folder: string; path: string };

const buildProjectSearchEntry = (project: Project): ProjectSearchEntry => {
  const path = normalizeSearchText(project.path);
  return {
    project,
    name: normalizeSearchText(project.name),
    folder: path.slice(path.lastIndexOf('/') + 1),
    path,
  };
};

// Projects are what the user names when they type a bare name, so a
// name hit ranks them just above a thread whose title matches equally well.
const ENTITY_NAME_WEIGHT = 1.15;

const scoreProjectSearchEntry = (entry: ProjectSearchEntry, query: SearchQuery, activityMs: number) => {
  let score = 0;
  for (const token of query.tokens) {
    let best = Math.max(
      scoreNameToken(entry.name, token) * ENTITY_NAME_WEIGHT,
      scoreNameToken(entry.folder, token) * 0.9
    );
    if (best < BODY_MATCH_WORD) best = Math.max(best, scoreBodyToken([entry.path], token));
    if (best === 0) return 0;
    score += best;
  }
  if (query.tokens.length > 1 && entry.name.includes(query.phrase)) score += 40;
  return score + recencyBonus(activityMs);
};

// The words a result's excerpt looks for: those its title doesn't explain.
const excerptTokens = (entry: ThreadSearchEntry, query: SearchQuery) =>
  query.tokens.filter((token) => token.length > 1 && !entry.title.includes(token));

/**
 * The line under a result: where the transcript matched a word the title
 * didn't explain (the most recent mention), else the newest message. From
 * main for transcripts that aren't loaded (requestRemoteExcerpts), the
 * project path until it answers.
 */
export const getThreadSearchExcerpt = (entry: ThreadSearchEntry, query: SearchQuery) => {
  const tokens = excerptTokens(entry, query);
  if (entry.messages) {
    return transcriptExcerpt(entry.messages, tokens, entry.body ?? undefined) ?? entry.projectPath;
  }
  return remoteExcerpts.get(excerptKey(entry.thread.id, tokens)) ?? entry.projectPath;
};

const requestExcerptsFor = (entries: ThreadSearchEntry[], query: SearchQuery) =>
  requestRemoteExcerpts(
    entries
      .filter((entry) => !entry.messages)
      .map((entry) => ({ threadId: entry.thread.id, tokens: excerptTokens(entry, query) }))
  );

/** Wraps each occurrence of a query word in <mark>. */
const highlightMatches = (text: string, tokens: readonly string[]): React.ReactNode => {
  if (!text || tokens.length === 0) return text;
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    for (let index = lower.indexOf(token); index !== -1 && ranges.length < 24; index = lower.indexOf(token, index + token.length)) {
      if (token.length > 1 || isWordStart(lower, index)) ranges.push([index, index + token.length]);
    }
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) nodes.push(text.slice(cursor, from));
    nodes.push(
      <mark key={from} className="search-hit">
        {text.slice(from, end)}
      </mark>
    );
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
};

type SearchResult =
  | { kind: 'project'; key: string; score: number; project: Project; threadCount: number }
  | { kind: 'thread'; key: string; score: number; entry: ThreadSearchEntry };

const projectNameFor = (project: Project | undefined) => project?.name ?? 'Unknown project';

/**
 * Keeps the index a step behind the store while it is streaming: a running
 * agent replaces its transcript on every chunk, and re-scoring that often
 * would compete with the typing it is meant to serve.
 */
const useThrottledThreads = () => {
  const threads = useOrionStore((state) => state.threads);
  const transcripts = useOrionStore((state) => state.transcripts);
  const latestRef = useRef({ threads, transcripts });
  const [indexed, setIndexed] = useState(latestRef.current);
  const timerRef = useRef<number | null>(null);

  latestRef.current = { threads, transcripts };
  useEffect(() => {
    if ((threads === indexed.threads && transcripts === indexed.transcripts) || timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setIndexed(latestRef.current);
    }, THREAD_SEARCH_INDEX_REFRESH_MS);
  }, [indexed, threads, transcripts]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  return indexed;
};

let lastWarmup = 0;

/**
 * Get transcript search ready before the first keystroke (hover, focus):
 * main loads its search texts, building any that are missing.
 */
export const warmSearchIndex = () => {
  const now = Date.now();
  // Hover and focus can arrive together; main keeps the texts a while anyway.
  if (now - lastWarmup < REMOTE_SCORES_TTL_MS) return;
  lastWarmup = now;
  // Transcript text may have changed since the last search.
  remoteBodyScores.clear();
  remoteExcerpts.clear();
  void window.orion?.warmThreadSearch?.().catch(() => {});
};

export type SidebarSearchPanelProps = {
  projects: Project[];
  onSelectThread: (threadId: string) => void;
  onSelectProject: (projectId: string) => void;
};

/**
 * The sidebar search popover: input, keyboard navigation and ranked results
 * across projects and threads. It owns its query, so typing re-renders
 * only this panel rather than the application shell, and it is mounted only
 * while open, so live transcript changes cost nothing while search is closed.
 */
export const SidebarSearchPanel = React.memo(function SidebarSearchPanel({
  projects,
  onSelectThread,
  onSelectProject,
}: SidebarSearchPanelProps) {
  const [query, setQuery] = useState('');
  // Scoring runs against the deferred copy, so the input never waits on it.
  const deferredQuery = useDeferredValue(query);
  const { threads, transcripts } = useThrottledThreads();
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const parsedQuery = useMemo(() => parseSearchQuery(deferredQuery), [deferredQuery]);
  const hasQuery = parsedQuery.tokens.length > 0;
  // Bumped when main answers for the transcripts that aren't loaded.
  const remoteRevision = useRemoteThreadSearch(parsedQuery.tokens);

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  // Per project: newest thread activity (for recency) and thread count.
  const threadStats = useMemo(() => {
    const stats = new Map<string, { activityMs: number; count: number }>();
    const bump = (key: string, activityMs: number) => {
      const current = stats.get(key);
      if (current) {
        current.count += 1;
        if (activityMs > current.activityMs) current.activityMs = activityMs;
      } else {
        stats.set(key, { activityMs, count: 1 });
      }
    };
    for (const thread of threads) {
      const activityMs = getThreadActivityTime(thread).getTime();
      bump(`project:${thread.projectId}`, activityMs);
    }
    return stats;
  }, [threads]);

  const projectEntries = useMemo(() => projects.map(buildProjectSearchEntry), [projects]);

  const threadEntries = useMemo(() => {
    const candidates = hasQuery
      ? threads
      : threads
          .slice()
          .sort((a, b) => getThreadActivityTime(b).getTime() - getThreadActivityTime(a).getTime())
          .slice(0, RECENT_THREAD_LIMIT);
    const buildEntry = hasQuery ? getThreadSearchEntry : buildThreadSearchSummary;
    return candidates.map((thread) => {
      const project = projectById.get(thread.projectId);
      return buildEntry(thread, projectNameFor(project), project?.path ?? '');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- transcripts: entries read them
  }, [hasQuery, projectById, threads, transcripts]);

  const results = useMemo<SearchResult[]>(() => {
    if (!hasQuery) {
      return threadEntries
        .map((entry) => ({ kind: 'thread', key: `thread:${entry.thread.id}`, score: 0, entry }));
    }

    const matches: SearchResult[] = [];
    for (const entry of projectEntries) {
      const stats = threadStats.get(`project:${entry.project.id}`);
      const score = scoreProjectSearchEntry(entry, parsedQuery, stats?.activityMs ?? NaN);
      if (score > 0) {
        matches.push({
          kind: 'project',
          key: `project:${entry.project.id}`,
          score,
          project: entry.project,
          threadCount: stats?.count ?? 0,
        });
      }
    }
    const threadMatches: Extract<SearchResult, { kind: 'thread' }>[] = [];
    for (const entry of threadEntries) {
      const score = scoreThreadSearchEntry(entry, parsedQuery);
      if (score > 0) threadMatches.push({ kind: 'thread', key: `thread:${entry.thread.id}`, score, entry });
    }
    threadMatches.sort(compareThreadSearchResults);
    matches.push(...threadMatches.slice(0, THREAD_RESULT_LIMIT));
    return matches.sort((a, b) => b.score - a.score).slice(0, RESULT_LIMIT);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remoteRevision: scores read main's answers
  }, [hasQuery, parsedQuery, projectEntries, remoteRevision, threadEntries, threadStats]);

  // Excerpts of listed threads whose transcript isn't loaded come from main.
  useEffect(() => {
    requestExcerptsFor(
      results.flatMap((result) => (result.kind === 'thread' ? [result.entry] : [])),
      parsedQuery
    );
  }, [parsedQuery, results]);

  useEffect(() => setActiveIndex(0), [parsedQuery]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-search-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const activate = (result: SearchResult | undefined) => {
    if (!result) return;
    if (result.kind === 'project') onSelectProject(result.project.id);
    else onSelectThread(result.entry.thread.id);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(results[activeIndex]);
    }
  };

  const tokens = parsedQuery.tokens;
  const stale = query !== deferredQuery;

  return (
    <div className="thread-search-panel">
      <div className="thread-search-input">
        <Search size={14} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search projects, threads..."
          aria-label="Search projects and threads"
        />
      </div>
      <div className={`thread-search-results ${stale ? 'stale' : ''}`} ref={listRef} role="listbox">
        {!hasQuery && results.length > 0 && <div className="thread-search-group-label">Recent threads</div>}
        {results.map((result, index) => {
          const active = index === activeIndex;
          const common = {
            type: 'button' as const,
            role: 'option',
            'aria-selected': active,
            'data-search-index': index,
            onMouseMove: () => {
              if (!active) setActiveIndex(index);
            },
            onClick: () => activate(result),
          };

          if (result.kind === 'project') {
            return (
              <button key={result.key} {...common} className={`thread-search-result compact ${active ? 'active' : ''}`}>
                <span className="thread-search-row">
                  <ProjectIcon projectPath={result.project.path} size={13} className="thread-search-kind-icon" />
                  <span className="thread-search-title">{highlightMatches(result.project.name, tokens)}</span>
                  <span className="thread-search-kind">Project</span>
                </span>
                <span className="thread-search-meta">
                  {result.threadCount} {result.threadCount === 1 ? 'thread' : 'threads'} · {result.project.path}
                </span>
              </button>
            );
          }

          const { entry } = result;
          return (
            <button key={result.key} {...common} className={`thread-search-result ${active ? 'active' : ''}`}>
              <span className="thread-search-row">
                <MessageSquare size={13} className="thread-search-kind-icon" />
                <span className="thread-search-title">{highlightMatches(entry.thread.title, tokens)}</span>
              </span>
              <span className="thread-search-meta">
                {entry.projectName} · {formatShortTime(getThreadActivityTime(entry.thread))}
              </span>
              <span className="thread-search-excerpt">
                {highlightMatches(getThreadSearchExcerpt(entry, parsedQuery), tokens)}
              </span>
            </button>
          );
        })}
        {results.length === 0 && (
          <div className="thread-search-empty">{hasQuery ? 'No matches' : 'No threads yet'}</div>
        )}
      </div>
    </div>
  );
});
