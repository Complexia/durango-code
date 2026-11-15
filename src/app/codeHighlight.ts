import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  continuesFrom,
  PLAIN_LANGUAGES,
  type EngineRequest,
  type HighlightedLine,
  type HighlightResponse,
  type StyleEntry,
} from './codeHighlightEngine';

/**
 * Syntax highlighting for fenced code in markdown. Shiki runs in a Web Worker
 * (codeHighlightEngine.ts), so tokenizing never blocks the transcript; this
 * side sends each block's text, applies the lines that come back after
 * commit, and keeps finished blocks in a cache bounded by memory. Colors are
 * `--code-*` CSS variables (index.css), so a theme restyles code without
 * re-highlighting it. Blocks only ask once they are near the viewport.
 */

export type { HighlightedLine } from './codeHighlightEngine';

/** Past these sizes a block stays plain. */
const MAX_HIGHLIGHT_CHARS = 100_000;
const MAX_HIGHLIGHT_LINES = 2_000;
/** Finished blocks kept highlighted, by estimated retained bytes. */
const CACHE_BYTES = 24 * 1024 * 1024;
const CACHE_MAX_ENTRY_BYTES = 3 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 500;
/** Streaming blocks that just unmounted, for the block that replaces them. */
const ORPHAN_LIMIT = 16;
const ORPHAN_TTL_MS = 10_000;

/** The fence's language word as written (`ts`, `Python`, `diff title="x"` → `diff`). */
export const fenceLanguage = (className: string | undefined) =>
  /(?:^|\s)language-([^\s]+)/.exec(className ?? '')?.[1]?.toLowerCase() ?? '';

// ---- Styles: the worker numbers each distinct style once; runs refer to it by index.

const styles: (React.CSSProperties | undefined)[] = [undefined];

const toStyle = ({ color, fontStyle }: StyleEntry): React.CSSProperties => {
  const style: React.CSSProperties = {};
  if (color) style.color = color;
  if (fontStyle & 1) style.fontStyle = 'italic';
  if (fontStyle & 2) style.fontWeight = 600;
  if (fontStyle & 4) style.textDecoration = 'underline';
  return style;
};

export const codeStyle = (index: number) => styles[index];

// ---- Worker

/** Mounted (and recently unmounted, see `release`) blocks, by their id in the worker. */
const clients = new Map<number, Client>();
let worker: Worker | null | undefined;

const getWorker = () => {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./codeHighlight.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
      const response = event.data;
      for (const entry of response.styles) styles[entry.index] = toStyle(entry);
      const client = clients.get(response.id);
      if (client) apply(client, response);
    };
    worker.onerror = () => {
      // Highlighting is optional: code stays plain from here on, and nothing
      // waits for answers that won't come.
      worker?.terminate();
      worker = null;
      for (const client of clients.values()) client.sent.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
};

/** Sends to the worker, starting it if needed; false when highlighting is unavailable. */
const send = (message: EngineRequest) => {
  const target = getWorker();
  target?.postMessage(message);
  return Boolean(target);
};

// ---- Block state, cache and hand-over

/** What a block shows: `lines` cover `base`, a prefix of the text that ends at a line boundary. */
export type BlockHighlight = {
  language: string;
  base: string;
  lines: HighlightedLine[];
  consumed: number;
  done: boolean;
  bytes: number;
};

const estimateBytes = (text: string, lines: HighlightedLine[]) => {
  let bytes = 96 + text.length * 2;
  for (const line of lines) {
    bytes += 32;
    for (const run of line) bytes += 40 + run.content.length * 2;
  }
  return bytes;
};

/** Finished blocks by text, least recently used first. */
const cache = new Map<string, BlockHighlight>();
let cacheBytes = 0;

const cacheGet = (language: string, text: string) => {
  const entry = cache.get(text);
  if (!entry || entry.language !== language) return undefined;
  cache.delete(text);
  cache.set(text, entry);
  return entry;
};

const cachePut = (text: string, entry: BlockHighlight) => {
  if (entry.bytes > CACHE_MAX_ENTRY_BYTES) return;
  const existing = cache.get(text);
  if (existing) {
    cache.delete(text);
    cacheBytes -= existing.bytes;
  }
  cache.set(text, entry);
  cacheBytes += entry.bytes;
  for (const [oldestText, oldest] of cache) {
    if (cacheBytes <= CACHE_BYTES && cache.size <= CACHE_MAX_ENTRIES) break;
    cache.delete(oldestText);
    cacheBytes -= oldest.bytes;
  }
};

type Sent = { text: string; final: boolean; language: string };

/**
 * One block's link to the worker: its id there, the requests in flight and
 * what it shows. It outlives the component briefly (see `release`).
 */
type Client = {
  id: number;
  sent: Map<number, Sent>;
  block: BlockHighlight | null;
  onChange: ((block: BlockHighlight) => void) | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
};

let nextBlockId = 0;
let nextSeq = 0;

const apply = (client: Client, response: HighlightResponse) => {
  const request = client.sent.get(response.seq);
  if (!request) return;
  for (const seq of client.sent.keys()) if (seq < response.seq) client.sent.delete(seq);
  const previous = client.block;
  const lines = response.reset || !previous ? response.lines : previous.lines.concat(response.lines);
  const next: BlockHighlight = {
    language: request.language,
    base: request.text.slice(0, response.consumed),
    lines,
    consumed: response.consumed,
    done: response.done,
    bytes: 0,
  };
  client.block = next;
  if (response.done && request.final && lines.length) {
    next.bytes = estimateBytes(request.text, lines);
    cachePut(request.text, next);
  }
  client.onChange?.(next);
};

const createClient = (): Client => {
  const client: Client = { id: (nextBlockId += 1), sent: new Map(), block: null, onChange: null, releaseTimer: null };
  clients.set(client.id, client);
  return client;
};

const dispose = (client: Client) => {
  clients.delete(client.id);
  client.sent.clear();
  if (worker) send({ type: 'drop', id: client.id });
};

/**
 * A streaming block remounts when the transcript freezes the text around it
 * into a segment (and may close in the same update). An unmounted client
 * with lines waits a moment for the block that replaces it, which takes it
 * over whole (worker session, requests in flight, lines), so nothing flashes
 * plain or is tokenized again.
 */
const orphans: Client[] = [];

const release = (client: Client) => {
  client.onChange = null;
  const block = client.block;
  if (!block?.lines.length || (block.done && cache.get(block.base) === block)) {
    dispose(client);
    return;
  }
  orphans.push(client);
  client.releaseTimer = setTimeout(() => {
    const index = orphans.indexOf(client);
    if (index !== -1) orphans.splice(index, 1);
    dispose(client);
  }, ORPHAN_TTL_MS);
  if (orphans.length > ORPHAN_LIMIT) {
    const oldest = orphans.shift();
    if (oldest) {
      if (oldest.releaseTimer) clearTimeout(oldest.releaseTimer);
      dispose(oldest);
    }
  }
};

const adoptOrphan = (language: string, text: string, final: boolean) => {
  let best = -1;
  orphans.forEach((client, index) => {
    const block = client.block;
    if (!block || block.language !== language || !continuesFrom(block.base, text, final)) return;
    if (best === -1 || block.consumed > (orphans[best].block?.consumed ?? 0)) best = index;
  });
  if (best === -1) return undefined;
  const [client] = orphans.splice(best, 1);
  if (client.releaseTimer) clearTimeout(client.releaseTimer);
  client.releaseTimer = null;
  return client;
};

/**
 * Whether a block with this text would have highlighting to show the moment it
 * mounts (a finished one in the cache, or a streaming block's hand-over). A
 * read only: the cache's order is untouched.
 */
export const hasReadyHighlight = (language: string, text: string, final: boolean) => {
  if (!language || PLAIN_LANGUAGES.has(language)) return false;
  if (final && cache.get(text)?.language === language) return true;
  return orphans.some((client) => {
    const block = client.block;
    return Boolean(block && block.language === language && continuesFrom(block.base, text, final));
  });
};

/** Fence languages that never get colors: their blocks render without the highlighter. */
export const isPlainLanguage = (language: string) => !language || PLAIN_LANGUAGES.has(language);

/** Internals, for scripts/test-code-highlight.mjs. */
export const highlightCacheInternals = {
  cacheGet,
  cachePut,
  estimateBytes,
  createClient,
  release,
  adoptOrphan,
  apply,
  stats: () => ({ entries: cache.size, bytes: cacheBytes, orphans: orphans.length, clients: clients.size }),
};

const tooLarge = (text: string) => {
  if (text.length > MAX_HIGHLIGHT_CHARS) return true;
  let lines = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lines += 1;
    if (lines > MAX_HIGHLIGHT_LINES) return true;
  }
  return false;
};

export type Highlight = {
  /** Tokens for the first `lines.length` lines. */
  lines: HighlightedLine[];
  /** Where the plain remainder of the text starts. */
  consumed: number;
};

/**
 * Highlighted lines for as much of `text` as the worker has done, or null
 * (nothing yet, plain text, unknown language, too large, or not `active`,
 * meaning not near the viewport). A streaming block's last line is only
 * highlighted once it has ended. Render only reads; requests go out and
 * results come in after commit.
 */
export const useHighlightedLines = (
  text: string,
  language: string,
  final: boolean,
  active = true
): Highlight | null => {
  const skip = !language || PLAIN_LANGUAGES.has(language) || tooLarge(text);
  const [block, setBlock] = useState<BlockHighlight | null>(() =>
    skip || !final ? null : (cacheGet(language, text) ?? null)
  );
  // This block's link to the worker, made when it first asks for highlighting
  // (or taken over from the block it replaces): blocks that never need one
  // (cached, far off screen) cost nothing here.
  const clientRef = useRef<Client | null>(null);

  // Mount: take over the client of the block this one replaces, if any, before
  // the first paint; unmount: hand the client on. (Effects, not render: a
  // render React throws away must not take an orphan.)
  useLayoutEffect(() => {
    const adopted = skip ? undefined : adoptOrphan(language, text, final);
    if (adopted) {
      clientRef.current = adopted;
      adopted.onChange = setBlock;
      if (adopted.block) setBlock((shown) => shown ?? adopted.block);
    }
    return () => {
      const client = clientRef.current;
      clientRef.current = null;
      if (client) release(client);
    };
    // Mount and unmount only: later text arrives through the request effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (skip || !active) return;
    const client = clientRef.current;
    const cached = final ? cacheGet(language, text) : undefined;
    if (cached) {
      if (client && client.block !== cached) {
        // Shown from the cache: whatever the worker still has in flight for
        // this block no longer applies, and its session starts over if asked again.
        client.sent.clear();
        client.block = cached;
        send({ type: 'drop', id: client.id });
      }
      setBlock((shown) => (shown === cached ? shown : cached));
      return;
    }
    const current = client?.block;
    if (current?.done && current.language === language && current.base === text) return;
    if (worker === null) return;
    let target = client;
    if (!target) {
      target = createClient();
      target.onChange = setBlock;
      clientRef.current = target;
    }
    const seq = (nextSeq += 1);
    target.sent.set(seq, { text, final, language });
    if (!send({ type: 'highlight', id: target.id, seq, language, text, final })) target.sent.clear();
  }, [skip, active, language, text, final]);

  if (skip || !active || !block || !block.lines.length || block.language !== language) return null;
  if (!continuesFrom(block.base, text, final)) return null;
  return { lines: block.lines, consumed: Math.min(block.consumed, text.length) };
};
