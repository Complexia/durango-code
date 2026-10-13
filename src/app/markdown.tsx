import React, { useContext, useRef } from 'react';
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageCircle, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { useOrionStore } from '../store';
import { localMediaSrc, videoFileNamePattern } from './attachments';
import { handleLightboxImageClick } from './imageLightbox';
import { resolveThreadReference, threadReferencePattern } from './promptContext';
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

export const MarkdownMedia: React.FC<{ src?: string; alt?: string; title?: string }> = ({
  src,
  alt,
  title,
}) => {
  const baseDirs = useContext(MarkdownBaseDirContext);
  if (!src) return null;

  const resolvedSrc = /^(https?|data|blob|orion-attachment):/i.test(src)
    ? src
    : localMediaSrc(src, baseDirs);

  if (videoFileNamePattern.test(src)) {
    return (
      <video
        className="markdown-media"
        src={resolvedSrc}
        controls
        preload="metadata"
        title={title ?? alt}
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
    />
  );
};

const THREAD_REFERENCE_SCHEME = 'orion-thread:';

// A clickable reference to another Orion thread, labelled with its current
// title. Cmd/Ctrl-click opens it in a split pane, like dragging it in from the
// sidebar. References to threads this app doesn't have stay inert text.
export const ThreadReferenceLink: React.FC<{ reference: string; children: React.ReactNode }> = ({
  reference,
  children,
}) => {
  const threadId = useOrionStore((state) => resolveThreadReference(reference, state.threads)?.id);
  const title = useOrionStore((state) =>
    threadId ? state.threads.find((thread) => thread.id === threadId)?.title : undefined
  );
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

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };

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

export const markdownComponents = { img: MarkdownMedia, a: MarkdownLink };
const markdownRemarkPlugins = [remarkGfm, remarkThreadReferences];

export const MarkdownContent: React.FC<{ content: string }> = React.memo(({ content }) => (
  <div className="markdown-content">
    <ReactMarkdown
      remarkPlugins={markdownRemarkPlugins}
      urlTransform={markdownUrlTransform}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
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
  return (
    <>
      {frozen.segments.map((segment, index) => (
        <MarkdownContent key={index} content={segment} />
      ))}
      {tail.trim() ? <MarkdownContent content={tail} /> : null}
    </>
  );
});
