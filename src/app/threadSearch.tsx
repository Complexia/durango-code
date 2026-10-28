import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Search } from 'lucide-react';
import { type Message, type Project, type Thread, useOrionStore } from '../store';
import { ProjectIcon } from './ProjectIcon';
import { formatShortTime, getThreadActivityTime } from './time';

export const THREAD_SEARCH_INDEX_REFRESH_MS = 150;

const RECENT_THREAD_LIMIT = 12;
const RESULT_LIMIT = 50;
const THREAD_RESULT_LIMIT = 40;
// Activity details range from a one-line command to a whole file's output.
// Short ones (commands, paths) are worth finding; long ones only add noise
// and indexing cost.
const ACTIVITY_DETAIL_INDEX_LIMIT = 400;
// Scores at or above this come from a name match, which always beats the best
// transcript match — so once a token hits a name the transcript is skipped.
const BODY_MATCH_WORD = 18;
const BODY_MATCH_SUBSTRING = 8;

const NON_ASCII = /[^\x00-\x7f]/;

export const normalizeSearchText = (value: string) => {
  let text = value.toLowerCase();
  // NFKD is the slow step and only matters for accented input.
  if (NON_ASCII.test(text)) text = text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return text
    .replace(/[^a-z0-9/_ .:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const WORD_SEPARATORS = ' /_.:-';
const isWordStart = (text: string, index: number) =>
  index === 0 || WORD_SEPARATORS.includes(text[index - 1]);

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

const scoreBodyToken = (chunks: readonly string[], token: string) => {
  if (token.length < 2) return 0;
  let found = false;
  for (const chunk of chunks) {
    let index = chunk.indexOf(token);
    // Common fragments recur thousands of times in a long transcript; a
    // handful of misses is enough to settle for a plain substring hit.
    for (let checks = 0; index !== -1 && checks < 8; checks += 1) {
      if (isWordStart(chunk, index)) return BODY_MATCH_WORD;
      found = true;
      index = chunk.indexOf(token, index + 1);
    }
    if (index !== -1) found = true;
  }
  return found ? BODY_MATCH_SUBSTRING : 0;
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
    const parts = [message.content];
    for (const activity of message.activities ?? []) {
      parts.push(activity.title);
      if (activity.detail && activity.detail.length <= ACTIVITY_DETAIL_INDEX_LIMIT) parts.push(activity.detail);
    }
    for (const file of message.changedFiles ?? []) parts.push(file.path);
    for (const attachment of message.attachments ?? []) parts.push(attachment.name);
    text = normalizeSearchText(parts.join(' '));
    messageTextCache.set(message, text);
  }
  return text;
};

export type ThreadSearchEntry = {
  thread: Thread;
  projectName: string;
  projectPath: string;
  title: string;
  project: string;
  /** Path, model and status: matched like transcript text, at half weight. */
  meta: string;
  /** Normalized text per message, index-aligned with thread.messages. */
  body: string[];
};

type CachedThreadSearchEntry = {
  projectName: string;
  projectPath: string;
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
  body: [],
});

export const getThreadSearchEntry = (
  thread: Thread,
  projectName: string,
  projectPath: string
): ThreadSearchEntry => {
  const cached = threadEntryCache.get(thread);
  if (cached && cached.projectName === projectName && cached.projectPath === projectPath) {
    return cached.entry;
  }
  const entry: ThreadSearchEntry = {
    ...buildThreadSearchSummary(thread, projectName, projectPath),
    body: thread.messages.map(normalizedMessageText),
  };
  threadEntryCache.set(thread, { projectName, projectPath, entry });
  return entry;
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
      best = Math.max(best, scoreBodyToken(entry.body, token), scoreBodyToken([entry.meta], token) * 0.5);
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

const excerptAround = (source: string, index: number) => {
  const start = index > 24 ? index - 24 : 0;
  const excerpt = source.slice(start, start + 140).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${source.length > start + 140 ? '…' : ''}`;
};

const flattenText = (text: string) => text.replace(/\s+/g, ' ').trim();

export const getThreadSearchExcerpt = (entry: ThreadSearchEntry, query: SearchQuery) => {
  const { messages } = entry.thread;
  // Show where the transcript matched a word the title didn't explain,
  // preferring the most recent mention.
  const bodyTokens = query.tokens.filter((token) => token.length > 1 && !entry.title.includes(token));
  for (const token of bodyTokens) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (!entry.body[index]?.includes(token)) continue;
      const source = flattenText(messages[index].content);
      const hit = source.toLowerCase().indexOf(token);
      if (hit !== -1) return excerptAround(source, hit);
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const source = flattenText(messages[index].content);
    if (source) return excerptAround(source, 0);
  }
  return entry.projectPath;
};

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
 * agent replaces `threads` on every chunk, and re-scoring that often would
 * compete with the typing it is meant to serve.
 */
const useThrottledThreads = () => {
  const threads = useOrionStore((state) => state.threads);
  const latestRef = useRef(threads);
  const [indexed, setIndexed] = useState(threads);
  const timerRef = useRef<number | null>(null);

  latestRef.current = threads;
  useEffect(() => {
    if (threads === indexed || timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setIndexed(latestRef.current);
    }, THREAD_SEARCH_INDEX_REFRESH_MS);
  }, [indexed, threads]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  return indexed;
};

let searchIndexWarmup: Generator<void> | null = null;

/** Warm the shared cache in bounded slices, yielding between messages. */
export const warmSearchIndex = () => {
  // Hover and focus can arrive together; share one pending pass.
  if (searchIndexWarmup) return;
  searchIndexWarmup = (function* () {
    const { threads, projects } = useOrionStore.getState();
    const projectById = new Map(projects.map((project) => [project.id, project]));
    for (const thread of threads) {
      const project = projectById.get(thread.projectId);
      const projectName = projectNameFor(project);
      const projectPath = project?.path ?? '';
      const cached = threadEntryCache.get(thread);
      if (!cached || cached.projectName !== projectName || cached.projectPath !== projectPath) {
        for (const message of thread.messages) {
          normalizedMessageText(message);
          yield;
        }
        getThreadSearchEntry(thread, projectName, projectPath);
      }
      yield;
    }
  })();

  const schedule = () => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 1000 });
    else window.setTimeout(() => run(), 0);
  };
  const run = (deadline?: IdleDeadline) => {
    const started = performance.now();
    for (let steps = 0; steps < 64; steps += 1) {
      if (steps > 0 && (performance.now() - started >= 4 || (deadline && deadline.timeRemaining() <= 0))) break;
      if (searchIndexWarmup?.next().done) {
        searchIndexWarmup = null;
        return;
      }
    }
    schedule();
  };
  schedule();
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
  const threads = useThrottledThreads();
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const parsedQuery = useMemo(() => parseSearchQuery(deferredQuery), [deferredQuery]);
  const hasQuery = parsedQuery.tokens.length > 0;

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
  }, [hasQuery, projectById, threads]);

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
  }, [hasQuery, parsedQuery, projectEntries, threadEntries, threadStats]);

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
