import React, { useContext, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageCircle, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { type Thread, useOrionStore } from '../store';
import { imageFileNamePattern, isLocalFilePath, localMediaSrc, videoFileNamePattern } from './attachments';
import { handleLightboxImageClick } from './imageLightbox';
import { sourceAttachmentSrc, useSourceAttachmentAccount } from './sourceAttachments';
import { resolveThreadReference, threadReferencePattern } from './promptContext';
import { CodeBlock } from './CodeBlock';
import { fenceLanguage } from './codeHighlight';
import { MermaidBlock } from './MermaidBlock';
import { chatIdFromReference, chatReferencePattern, knownDurangoChat, knownDurangoChats, knownDurangoChatUrl } from './durangoChats';

// Candidate base directories (in priority order) used to resolve relative
// media paths that agents emit in markdown — the thread's project path, plus
// provider-specific output dirs (e.g. the grok CLI's session dir, where Grok
// Imagine saves generated images and references them relatively).
export const MarkdownBaseDirContext = React.createContext<string[]>([]);

const bareSourceLocationPattern = /^(?!(?:javascript|data|vbscript|https?|mailto|tel):)(?:[^:/?#]+[\\/])*[^:/?#]+:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/i;

// react-markdown's default transform strips unknown schemes; let local file
// references through so MarkdownMedia can route them via orion-attachment.
export const markdownUrlTransform = (url: string) =>
  /^(orion-attachment|orion-thread|durango-chat|file):/i.test(url) ||
  /^[a-zA-Z]:[\\/]/.test(url) ||
  bareSourceLocationPattern.test(url)
    ? url
    : defaultUrlTransform(url);

export const MarkdownMedia: React.FC<{
  src?: string;
  alt?: string;
  title?: string;
  'data-path-preview'?: unknown;
}> = ({ src, alt, title, 'data-path-preview': pathPreview }) => {
  const baseDirs = useContext(MarkdownBaseDirContext);
  const sourceAccount = useSourceAttachmentAccount();
  const [failed, setFailed] = useState(false);
  if (!src) return null;
  // A preview of a path the agent only mentioned disappears when the file
  // isn't there; an image the agent embedded keeps its broken-image marker.
  if (failed) return null;
  const isPathPreview = pathPreview !== undefined;
  const handleError = isPathPreview ? () => setFailed(true) : undefined;

  // Durango Source description images load through the main process with
  // the device's repository token (./sourceAttachments.ts).
  const resolvedSrc =
    sourceAttachmentSrc(src, sourceAccount) ??
    (/^(https?|data|blob|orion-attachment|orion-source-attachment):/i.test(src) ? src : localMediaSrc(src, baseDirs));

  if (videoFileNamePattern.test(src)) {
    return (
      <video
        className="markdown-media"
        src={resolvedSrc}
        controls
        preload="metadata"
        title={title ?? alt}
        data-path-preview={isPathPreview ? '' : undefined}
        onError={handleError}
      />
    );
  }
  return (
    <img
      className="markdown-media"
      src={resolvedSrc}
      alt={alt ?? ''}
      title={title}
      loading="lazy"
      data-lightbox=""
      onClick={handleLightboxImageClick}
      data-path-preview={isPathPreview ? '' : undefined}
      onError={handleError}
    />
  );
};

const THREAD_REFERENCE_SCHEME = 'orion-thread:';

const threadReferenceCache = new WeakMap<Thread[], Map<string, Thread | undefined>>();
const resolveThreadReferenceCached = (reference: string, threads: Thread[]) => {
  let resolved = threadReferenceCache.get(threads);
  if (!resolved) {
    resolved = new Map();
    threadReferenceCache.set(threads, resolved);
  }
  if (!resolved.has(reference)) resolved.set(reference, resolveThreadReference(reference, threads));
  return resolved.get(reference);
};

// A clickable reference to another Orion thread, labelled with its current
// title. Cmd/Ctrl-click opens it in a split pane, like dragging it in from the
// sidebar. References to threads this app doesn't have stay inert text.
export const ThreadReferenceLink: React.FC<{ reference: string; children: React.ReactNode }> = ({
  reference,
  children,
}) => {
  // Resolved once per `threads` array (it changes only when a shell does), not
  // on every store update: transcripts stream many updates a second.
  const thread = useOrionStore((state) => resolveThreadReferenceCached(reference, state.threads));
  const threadId = thread?.id;
  const title = thread?.title;
  if (!threadId) {
    return <span title="This thread isn't available in Durango Code">{children}</span>;
  }

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const store = useOrionStore.getState();
    if (event.metaKey || event.ctrlKey) store.openThreadInSplit(threadId);
    else store.selectThread(threadId);
    store.setSettingsOpen(false);
    store.setActiveTab('agents');
  };

  return (
    <button
      type="button"
      className="thread-reference"
      onClick={handleClick}
      title={`Open thread${title ? ` "${title}"` : ''} (⌘/Ctrl-click opens it in a split)`}
    >
      <MessageSquare size={12} aria-hidden />
      <span>{title?.trim() || children}</span>
    </button>
  );
};

const CHAT_REFERENCE_SCHEME = 'durango-chat:';

// A Durango Chat reference (`@chat:<slug>-<chatId>` or `@chat:<chatId>`):
// opens that chat in the browser. Titles come from chats seen in @-mention
// search results; otherwise the token text stays the label.
export const ChatReferenceLink: React.FC<{ reference: string; children: React.ReactNode }> = ({
  reference,
  children,
}) => {
  const chatId = chatIdFromReference(reference, knownDurangoChats());
  if (!chatId) return <>{children}</>;
  const title = knownDurangoChat(chatId)?.title?.trim();

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      try {
        const result = await window.orion?.durangoOpenChat?.({ chatId, url: knownDurangoChatUrl(chatId) });
        if (result && !result.ok) toast.error(result.error ?? 'Could not open the Durango chat.');
      } catch {
        toast.error('Could not open the Durango chat.');
      }
    })();
  };

  return (
    <button
      type="button"
      className="thread-reference chat-reference"
      onClick={handleClick}
      title={`Open Durango chat${title ? ` "${title}"` : ''} in your browser`}
    >
      <MessageCircle size={12} aria-hidden />
      <span>{title || children}</span>
    </button>
  );
};

type ReferenceMatch = { kind: 'thread' | 'chat'; start: number; text: string; reference: string };

// @thread and @chat references in one pass, in text order. Their prefixes
// differ, so matches never overlap.
const findReferences = (text: string): ReferenceMatch[] => {
  const matches: ReferenceMatch[] = [];
  if (text.includes('@thread:')) {
    for (const match of text.matchAll(threadReferencePattern)) {
      matches.push({ kind: 'thread', start: match.index ?? 0, text: match[0], reference: match[1] });
    }
  }
  if (text.includes('@chat:')) {
    for (const match of text.matchAll(chatReferencePattern)) {
      matches.push({ kind: 'chat', start: match.index ?? 0, text: match[0], reference: match[1] });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
};

// Plain text (user messages) with its @thread and @chat references made clickable.
export const ThreadReferenceText: React.FC<{ text: string }> = React.memo(({ text }) => {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of findReferences(text)) {
    const { start } = match;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      match.kind === 'thread' ? (
        <ThreadReferenceLink key={start} reference={match.reference}>
          {match.text}
        </ThreadReferenceLink>
      ) : (
        <ChatReferenceLink key={start} reference={match.reference}>
          {match.text}
        </ChatReferenceLink>
      )
    );
    last = start + match.text.length;
  }
  if (last === 0) return <>{text}</>;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
});

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: MarkdownNode[];
};

const referenceLinkNode = (match: Pick<ReferenceMatch, 'kind' | 'reference'>, children: MarkdownNode[]): MarkdownNode => ({
  type: 'link',
  url: `${match.kind === 'thread' ? THREAD_REFERENCE_SCHEME : CHAT_REFERENCE_SCHEME}${match.reference}`,
  children,
});

const splitThreadReferences = (value: string): MarkdownNode[] | null => {
  const nodes: MarkdownNode[] = [];
  let last = 0;
  for (const match of findReferences(value)) {
    const { start } = match;
    if (start > last) nodes.push({ type: 'text', value: value.slice(last, start) });
    nodes.push(referenceLinkNode(match, [{ type: 'text', value: match.text }]));
    last = start + match.text.length;
  }
  if (last === 0) return null;
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) });
  return nodes;
};

const linkThreadReferences = (node: MarkdownNode) => {
  // Text already inside a link keeps that link's target.
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value) return splitThreadReferences(child.value) ?? [child];
    if (child.type === 'inlineCode' && child.value) {
      // Only a code span that is exactly one reference, e.g. `@thread:<id>`
      // or `@chat:<id>`.
      const match = findReferences(child.value.trim());
      if (match.length === 1 && match[0].text === child.value.trim()) {
        return [referenceLinkNode(match[0], [child])];
      }
      return [child];
    }
    linkThreadReferences(child);
    return [child];
  });
};

// Remark plugin: turn `@thread:<id or mention token>` and `@chat:<…>` in prose
// into links the `a` renderer below opens as threads / Durango chats.
export const remarkThreadReferences = () => (tree: MarkdownNode) => linkThreadReferences(tree);

export const MarkdownLink: React.FC<React.ComponentPropsWithoutRef<'a'> & ExtraProps> = ({
  href,
  children,
  node: _node,
  ...props
}) => {
  const baseDirs = useContext(MarkdownBaseDirContext);

  if (href?.startsWith(THREAD_REFERENCE_SCHEME)) {
    return (
      <ThreadReferenceLink reference={href.slice(THREAD_REFERENCE_SCHEME.length)}>
        {children}
      </ThreadReferenceLink>
    );
  }
  if (href?.startsWith(CHAT_REFERENCE_SCHEME)) {
    return (
      <ChatReferenceLink reference={href.slice(CHAT_REFERENCE_SCHEME.length)}>{children}</ChatReferenceLink>
    );
  }

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!href || href.startsWith('#') || !window.orion) return;

    void (async () => {
      try {
        const webHref = href.startsWith('//') ? `https:${href}` : href;
        if (/^https?:\/\//i.test(webHref)) {
          const result = await window.orion.openExternalUrl(webHref);
          if (!result.ok) toast.error(result.error ?? 'Could not open the link.');
          return;
        }

        const result = await window.orion.openLinkedFile({ href, baseDirs });
        if (!result.ok || !result.path || result.content === undefined) {
          toast.error(result.error ?? 'Could not open the linked file.');
          return;
        }
        const store = useOrionStore.getState();
        store.openFile(result.path, result.content);
        store.setSettingsOpen(false);
        store.setActiveTab('code');
      } catch {
        toast.error('Could not open the link.');
      }
    })();
  };

  return (
    <a {...props} href={href} onClick={handleClick}>
      {children}
    </a>
  );
};

// An absolute local path to an image or video, as agents write it when they
// report a screenshot or recording (`/tmp/shots/home.png`, `~/out.mp4`,
// `file:///…`, `C:\…`). Relative paths stay text: they're usually source
// files under discussion, not something to show.
const isMediaPath = (value: string) =>
  (isLocalFilePath(value) || /^file:\/\//i.test(value)) &&
  (imageFileNamePattern.test(value) || videoFileNamePattern.test(value));

// The same paths inside prose, where they end at whitespace or punctuation.
const proseMediaPathPattern =
  /(?<=^|[\s(])(?:file:\/\/|~\/|\/)[^\s`'"<>()[\]]*\.(?:apng|avif|gif|jpe?g|png|svg|webp|mp4|webm|mov|m4v|ogv|mkv|avi)(?=$|[\s,;:!?)\]]|\.(?:\s|$))/gi;

const collectMediaPaths = (node: MarkdownNode, paths: string[]) => {
  for (const child of node.children ?? []) {
    if (child.type === 'inlineCode' && child.value && isMediaPath(child.value.trim())) {
      paths.push(child.value.trim());
    } else if (child.type === 'text' && child.value?.includes('/')) {
      for (const match of child.value.matchAll(proseMediaPathPattern)) paths.push(match[0]);
    } else if (child.type === 'link') {
      // The link's target, not its label.
      if (child.url && isMediaPath(child.url)) paths.push(child.url);
    } else if (child.type !== 'image') {
      collectMediaPaths(child, paths);
    }
  }
};

const collectImageUrls = (node: MarkdownNode, urls: Set<string>) => {
  if (node.type === 'image' && node.url) urls.add(node.url);
  for (const child of node.children ?? []) collectImageUrls(child, urls);
};

const previewMediaPaths = (node: MarkdownNode, shown: Set<string>) => {
  for (const child of node.children ?? []) {
    if (child.type !== 'paragraph') {
      previewMediaPaths(child, shown);
      continue;
    }
    const paths: string[] = [];
    collectMediaPaths(child, paths);
    for (const path of paths) {
      if (shown.has(path)) continue;
      shown.add(path);
      child.children?.push({
        type: 'image',
        url: path,
        alt: path.split(/[\\/]/).pop(),
        data: { hProperties: { dataPathPreview: '' } },
      });
    }
  }
};

// Remark plugin: show the image or video behind a local path an agent
// mentions (`/tmp/shot.png` in a code span, a link, or plain prose) below the
// paragraph that mentions it, once per path, unless the message already
// embeds it as an image.
export const remarkMediaPathPreviews = () => (tree: MarkdownNode) => {
  const shown = new Set<string>();
  collectImageUrls(tree, shown);
  previewMediaPaths(tree, shown);
};

/** Raw markdown of the document being rendered, to tell an open code fence from a closed one. */
const MarkdownSourceContext = React.createContext('');

/** Line endings in `text` between `from` and `to`: LF, CR and CRLF (one each), as the parser counts them. */
const countLineEndings = (text: string, from = 0, to = text.length) => {
  let count = 0;
  for (let index = from; index < to; index += 1) {
    const char = text.charCodeAt(index);
    if (char === 10) count += 1;
    else if (char === 13) {
      count += 1;
      if (text.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return count;
};

/**
 * Whether a fenced code block has its closing fence yet, from the parser's
 * own output: `source.slice(start, end)` is the block's raw markdown and
 * `contentText` its code text as rendered (the parser's value plus a newline).
 * A closed block spans one more line ending than its content (opener,
 * content, closer), and its last line is a fence. Indented code has no fence
 * and is always complete. Runs on every streamed chunk, so it only counts
 * line endings and never builds per-line strings.
 */
export const isFencedCodeClosed = (source: string, start: number, end: number, contentText: string): boolean => {
  let first = start;
  while (first < end && (source[first] === ' ' || source[first] === '\t' || source[first] === '>')) first += 1;
  const fenceChar = source[first];
  if ((fenceChar !== '`' && fenceChar !== '~') || source[first + 1] !== fenceChar || source[first + 2] !== fenceChar) {
    return true;
  }
  if (countLineEndings(source, start, end) <= countLineEndings(contentText)) return false;
  const lastLineStart = Math.max(source.lastIndexOf('\n', end - 1), source.lastIndexOf('\r', end - 1)) + 1;
  const lastLine = source.slice(lastLineStart, end).replace(/[ \t>]/g, '');
  return lastLine.length >= 3 && [...lastLine].every((char) => char === fenceChar);
};

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown; [key: string]: unknown };
  children?: HastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const hastText = (node: HastNode): string =>
  node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(hastText).join('');

// Fenced and indented code: highlighted blocks, and Mermaid fences as diagrams.
// Inline code never reaches here (react-markdown only wraps blocks in <pre>).
export const MarkdownPre: React.FC<React.ComponentPropsWithoutRef<'pre'> & ExtraProps> = ({ node, children }) => {
  const source = useContext(MarkdownSourceContext);
  const hast = node as HastNode | undefined;
  const codeNode = hast?.children?.find((child) => child.type === 'element' && child.tagName === 'code');
  if (!hast || !codeNode) return <pre>{children}</pre>;
  const className = codeNode.properties?.className;
  const language = fenceLanguage(Array.isArray(className) ? className.join(' ') : String(className ?? ''));
  let code = hastText(codeNode);
  const start = hast.position?.start.offset;
  const end = hast.position?.end.offset;
  const closed = start === undefined || end === undefined || !source ? true : isFencedCodeClosed(source, start, end, code);
  // An open fence runs to the end of the text, and the code text always ends
  // in a newline, even when the last line is still being written. Drop that
  // newline so the unfinished line reads as unfinished.
  const lastChar = source.charCodeAt(source.length - 1);
  if (!closed && lastChar !== 10 && lastChar !== 13) code = code.replace(/\n$/, '');
  if (language === 'mermaid') return <MermaidBlock code={code} closed={closed} />;
  return <CodeBlock code={code} language={language} final={closed} />;
};

/** Columns whose longest cell is at least this many characters read as prose. */
const PROSE_COLUMN_CHARS = 40;

/**
 * Cells of the prose columns of a table: they keep a readable width (index.css)
 * instead of being squeezed to one word per line by a neighbour that can't
 * wrap (a long path in a code span); the table scrolls sideways instead.
 */
export const proseTableCells = (table: HastNode): Set<HastNode> => {
  const rows: HastNode[][] = [];
  const collect = (node: HastNode) => {
    for (const child of node.children ?? []) {
      if (child.type !== 'element') continue;
      if (child.tagName === 'tr') {
        rows.push((child.children ?? []).filter((cell) => cell.tagName === 'td' || cell.tagName === 'th'));
      } else collect(child);
    }
  };
  collect(table);
  const longest: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      longest[column] = Math.max(longest[column] ?? 0, hastTextLength(cell));
    });
  }
  const cells = new Set<HastNode>();
  for (const row of rows) {
    row.forEach((cell, column) => {
      if ((longest[column] ?? 0) >= PROSE_COLUMN_CHARS) cells.add(cell);
    });
  }
  return cells;
};

/** Text length of a hast subtree, without building the string. */
const hastTextLength = (node: HastNode): number =>
  node.type === 'text' ? (node.value ?? '').length : (node.children ?? []).reduce((sum, child) => sum + hastTextLength(child), 0);

/**
 * Rehype plugin for tables, done once while parsing instead of by a React
 * component per table and per cell: each table goes in a scrolling wrapper
 * (`.markdown-table`, so a wide table scrolls inside the message instead of
 * squeezing its columns), and the cells of its prose columns get
 * `data-prose` (a readable minimum width in index.css).
 */
export const rehypeMarkdownTables = () => (tree: HastNode) => {
  const visit = (node: HastNode) => {
    const children = node.children;
    if (!children) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child.type !== 'element') continue;
      if (child.tagName !== 'table') {
        visit(child);
        continue;
      }
      for (const cell of proseTableCells(child)) {
        cell.properties = { ...cell.properties, dataProse: '' };
      }
      children[index] = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['markdown-table'] },
        children: [child],
        position: child.position,
      };
    }
  };
  visit(tree);
};

export const markdownComponents = { img: MarkdownMedia, a: MarkdownLink, pre: MarkdownPre };
const markdownRemarkPlugins = [remarkGfm, remarkThreadReferences, remarkMediaPathPreviews];
// For a message that shows its files itself (a bot reply's attachments): paths it names stay text.
const markdownRemarkPluginsNoPathPreviews = [remarkGfm, remarkThreadReferences];
const markdownRehypePlugins = [rehypeMarkdownTables];

// The rendered blocks of one markdown document, without a container, so the
// segments of a streaming message can share one `.markdown-content`.
const MarkdownBlocks: React.FC<{ content: string; pathPreviews?: boolean }> = React.memo(({ content, pathPreviews = true }) => (
  <MarkdownSourceContext.Provider value={content}>
    <ReactMarkdown
      remarkPlugins={pathPreviews ? markdownRemarkPlugins : markdownRemarkPluginsNoPathPreviews}
      rehypePlugins={markdownRehypePlugins}
      urlTransform={markdownUrlTransform}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
  </MarkdownSourceContext.Provider>
));

export const MarkdownContent: React.FC<{ content: string; pathPreviews?: boolean }> = React.memo(({ content, pathPreviews }) => (
  <div className="markdown-content">
    <MarkdownBlocks content={content} pathPreviews={pathPreviews} />
  </div>
));

// How large the live (re-parsed every render) tail of a streaming message may
// grow before its stable prefix is frozen into a memoized segment.
const STREAMING_FREEZE_THRESHOLD = 3000;

// A boundary where `text` can be split into two independently rendered
// markdown documents without changing what they render: after a blank line,
// outside any code fence, where the next line opens a fresh top-level block —
// not a list item, indented code, table row, or blockquote, all of which could
// belong to the block above the blank line (splitting a loose list, for
// example, would restart its numbering). Returns the index the second document
// starts at, or -1 when the text holds no such point.
const findStreamingCut = (text: string): number => {
  const lines = text.split('\n');
  let inFence = false;
  let fenceChar = '';
  let offset = 0;
  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar) {
        inFence = false;
      }
    }
    if (!inFence && i > 0 && line.trim() === '') {
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === '') next += 1;
      // The final line may still be mid-stream; never cut directly before it.
      if (next < lines.length - 1) {
        const opener = lines[next];
        const continuesPriorBlock = /^(\s{4,}|\s*([-*+]\s|\d{1,9}[.)]\s|>|\|))/.test(opener);
        if (!continuesPriorBlock) {
          let start = offset + line.length + 1;
          for (let j = i + 1; j < next; j += 1) start += lines[j].length + 1;
          cut = start;
        }
      }
    }
    offset += line.length + 1;
  }
  return cut;
};

type FrozenMarkdown = { segments: string[]; joined: string };

/**
 * Markdown for content that is still being appended to. Re-rendering a plain
 * MarkdownContent re-parses the entire text on every streamed chunk — an
 * O(transcript²) churn that grinds long turns and balloons the renderer's
 * native memory (the cause of the runaway-memory crashes on long threads).
 * This wrapper freezes the already-streamed prefix into memoized segments at
 * safe block boundaries, so each update re-parses only a small live tail.
 */
export const StreamingMarkdownContent: React.FC<{ content: string }> = React.memo(({ content }) => {
  const frozenRef = useRef<FrozenMarkdown>({ segments: [], joined: '' });
  let frozen = frozenRef.current;
  // Anything but a pure append (a different message's text after a key reuse,
  // a segment re-split by a new activity anchor) invalidates the frozen
  // prefix: start over from the new text.
  if (frozen.joined && !content.startsWith(frozen.joined)) {
    frozen = { segments: [], joined: '' };
    frozenRef.current = frozen;
  }
  let tail = content.slice(frozen.joined.length);
  if (tail.length > STREAMING_FREEZE_THRESHOLD) {
    const cut = findStreamingCut(tail);
    if (cut > 0) {
      frozen = {
        segments: [...frozen.segments, tail.slice(0, cut)],
        joined: frozen.joined + tail.slice(0, cut),
      };
      frozenRef.current = frozen;
      tail = content.slice(frozen.joined.length);
    }
  }
  // One container for every segment: the blocks are siblings exactly as if the
  // text had been parsed whole, so a heading that opens a segment keeps its top
  // margin (`.markdown-content > :first-child` would zero it in a container of
  // its own) and margins between segments collapse as usual.
  if (!frozen.segments.length && !tail.trim()) return null;
  return (
    <div className="markdown-content">
      {frozen.segments.map((segment, index) => (
        <MarkdownBlocks key={index} content={segment} />
      ))}
      {tail.trim() ? <MarkdownBlocks content={tail} /> : null}
    </div>
  );
});
