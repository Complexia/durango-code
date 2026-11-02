import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Code2, Copy, Maximize2, RotateCw, X } from 'lucide-react';
import type { AgentVisual } from '../store';
import {
  buildVisualDocument,
  clampVisualHeight,
  parseVisualMessage,
  resolveVisualTheme,
  VISUAL_AUTO_INITIAL_HEIGHT,
  VISUAL_SANDBOX,
} from './visualDocument';

/**
 * A page an agent showed with show_html (src/main/visual-tools.js), inline in
 * the transcript where the call ran. No card around it: the page sits on the
 * thread at the reply's width, with a small toolbar on hover (reload, source,
 * fullscreen). The page runs in a sandboxed frame with no network
 * (visualDocument.ts) that the main window never lets navigate (main.js);
 * content-fitted frames follow the page's height. Links the page asks to open
 * wait for the user's click on a prompt here.
 */

const readTheme = () => {
  if (typeof document === 'undefined') return {};
  const style = getComputedStyle(document.documentElement);
  return resolveVisualTheme((name) => style.getPropertyValue(name));
};

/** Mount once the frame is near the viewport; never unmount afterwards. */
const useNearViewport = <T extends Element,>() => {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || near) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return { ref, near };
};

const TOOL_BUTTON =
  'inline-flex h-7 w-7 items-center justify-center rounded-md text-[#a0a0a8] transition hover:bg-white/10 hover:text-[#ececef] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]/60';

const ToolButton: React.FC<{ label: string; onClick: () => void; children: React.ReactNode; buttonRef?: React.Ref<HTMLButtonElement> }> = ({
  label,
  onClick,
  children,
  buttonRef,
}) => (
  <button ref={buttonRef} type="button" onClick={onClick} title={label} aria-label={label} className={TOOL_BUTTON}>
    {children}
  </button>
);

type FrameProps = {
  visual: AgentVisual;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onReload: () => void;
  onToggleSource: () => void;
  sourceOpen: boolean;
  onError: (message: string) => void;
  /** The page asked to open a link (page script can ask without a click). */
  onLink: (href: string) => void;
  /** Trusted prompt to open the asked-for link, shown under the frame. */
  linkPrompt: React.ReactNode;
};

/**
 * One sandboxed run of the page; remount (key) to reload. Fullscreen expands
 * this same frame: the holder is a <dialog> that stays where it is in the
 * DOM (moving an iframe reloads it and loses the page's state). Closed it is
 * styled as an ordinary block; expanded, showModal() lifts it into the top
 * layer over the whole window and closes on Escape.
 */
const VisualFrame: React.FC<FrameProps> = ({
  visual,
  expanded,
  onExpand,
  onCollapse,
  onReload,
  onToggleSource,
  sourceOpen,
  onError,
  onLink,
  linkPrompt,
}) => {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const loads = useRef(0);
  const [autoHeight, setAutoHeight] = useState(visual.height ?? VISUAL_AUTO_INITIAL_HEIGHT);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const { ref: holderRef, near } = useNearViewport<HTMLDivElement>();
  const headingId = useId();
  const srcDoc = useMemo(() => buildVisualDocument(visual.html, readTheme()), [visual.html]);

  useEffect(() => {
    if (!near) return undefined;
    const onMessage = (event: MessageEvent) => {
      // Only this frame's window; other frames and the app itself are ignored.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = parseVisualMessage(event.data);
      if (!message) return;
      if (message.type === 'resize') setAutoHeight(clampVisualHeight(message.height, window.innerHeight));
      else if (message.type === 'escape') {
        if (expanded) onCollapse();
      } else if (message.type === 'link') onLink(message.href);
      else onError(message.message);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [near, expanded, onCollapse, onError, onLink]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!expanded) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        onCollapse();
        return;
      }
    }
    closeRef.current?.focus();
  }, [expanded, onCollapse]);

  // A second load means the page navigated itself (location =, meta
  // refresh): stop the frame instead of showing whatever it navigated to.
  const onLoad = useCallback(() => {
    loads.current += 1;
    if (loads.current > 1) {
      setNavigatedAway(true);
      onError('The visual tried to navigate away and was stopped.');
    }
  }, [onError]);

  const height = expanded ? undefined : (visual.height ?? autoHeight);

  return (
    <dialog
      ref={dialogRef}
      role={expanded ? undefined : 'group'}
      aria-label={expanded ? undefined : visual.title}
      aria-labelledby={expanded ? headingId : undefined}
      onClose={(event) => {
        if (expanded && !event.currentTarget.open) onCollapse();
      }}
      onKeyDown={(event) => {
        if (expanded && event.key === 'Escape') event.stopPropagation();
      }}
      className={
        expanded
          ? 'fixed inset-0 m-0 flex h-screen max-h-none w-screen max-w-none flex-col gap-2 overflow-hidden border-0 bg-[#101012] p-3 text-inherit backdrop:bg-black/70'
          : 'group/visual relative m-0 block h-auto max-h-none w-full max-w-none overflow-visible border-0 bg-transparent p-0 text-inherit'
      }
    >
      {expanded ? (
        <div className="flex shrink-0 items-center gap-1 pl-1">
          <h2 id={headingId} className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#ececef]">
            {visual.title}
          </h2>
          <ToolButton label="Reload" onClick={onReload}>
            <RotateCw size={14} />
          </ToolButton>
          <ToolButton label="Exit fullscreen" onClick={onCollapse} buttonRef={closeRef}>
            <X size={15} />
          </ToolButton>
        </div>
      ) : (
        <div
          className="absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded-lg border border-white/10 bg-[#161619]/95 p-0.5 opacity-0 shadow-lg shadow-black/40 transition-opacity focus-within:opacity-100 group-hover/visual:opacity-100"
        >
          <ToolButton label="Reload" onClick={onReload}>
            <RotateCw size={13} />
          </ToolButton>
          <ToolButton label={sourceOpen ? 'Hide source' : 'View source'} onClick={onToggleSource}>
            <Code2 size={14} />
          </ToolButton>
          <ToolButton label="Fullscreen" onClick={onExpand}>
            <Maximize2 size={13} />
          </ToolButton>
        </div>
      )}
      <div
        ref={holderRef}
        className={expanded ? 'relative min-h-0 w-full flex-1 overflow-hidden' : 'relative w-full overflow-hidden'}
        style={height !== undefined ? { height } : undefined}
      >
        {near && !navigatedAway ? (
          <iframe
            ref={frameRef}
            title={visual.title}
            srcDoc={srcDoc}
            sandbox={VISUAL_SANDBOX}
            allow=""
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            className="block h-full w-full border-0 bg-transparent"
            // Same scheme as the page inside, or Chromium paints an opaque
            // backdrop behind the transparent frame.
            style={{ colorScheme: 'dark' }}
            data-testid="html-visual-frame"
          />
        ) : navigatedAway ? (
          <div role="note" className="grid h-full w-full place-items-center p-4 text-center text-[12px] text-[#a0a0a8]">
            This visual tried to navigate away and was stopped. Use Reload to run it again.
          </div>
        ) : (
          <div className="h-full w-full animate-pulse rounded-lg bg-white/[0.03]" aria-hidden />
        )}
      </div>
      {linkPrompt}
    </dialog>
  );
};

/** Short form of a link for the prompt: host and the start of the path. */
const linkLabel = (href: string) => {
  try {
    const url = new URL(href);
    const rest = `${url.pathname === '/' ? '' : url.pathname}${url.search}`;
    return `${url.host}${rest.length > 48 ? `${rest.slice(0, 48)}…` : rest}`;
  } catch {
    return href.slice(0, 64);
  }
};

export const HtmlVisual: React.FC<{ visual: AgentVisual }> = ({ visual }) => {
  const [runKey, setRunKey] = useState(0);
  const [errors, setErrors] = useState<{ shown: string[]; more: number }>({ shown: [], more: 0 });
  const [sourceOpen, setSourceOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  // A link the page asked to open. Page script can ask without the user
  // clicking anything, so it only opens from this prompt, on a real click in
  // the app; a newer ask replaces an older one.
  const [pendingLink, setPendingLink] = useState<string | null>(null);

  const onError = useCallback((message: string) => {
    setErrors((current) => {
      if (current.shown.includes(message)) return current;
      return current.shown.length < 3
        ? { ...current, shown: [...current.shown, message] }
        : { ...current, more: current.more + 1 };
    });
  }, []);
  const reload = useCallback(() => {
    setErrors({ shown: [], more: 0 });
    setRunKey((key) => key + 1);
  }, []);
  const collapse = useCallback(() => setExpanded(false), []);
  const expand = useCallback(() => setExpanded(true), []);
  const toggleSource = useCallback(() => setSourceOpen((open) => !open), []);
  const onLink = useCallback((href: string) => setPendingLink(href), []);
  const openLink = useCallback(() => {
    if (pendingLink) void window.orion?.openExternalUrl?.(pendingLink);
    setPendingLink(null);
  }, [pendingLink]);
  const copySource = useCallback(() => {
    void navigator.clipboard?.writeText(visual.html).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [visual.html]);

  return (
    <div className="html-visual my-2" data-testid="html-visual">
      <VisualFrame
        key={runKey}
        visual={visual}
        expanded={expanded}
        onExpand={expand}
        onCollapse={collapse}
        onReload={reload}
        onToggleSource={toggleSource}
        sourceOpen={sourceOpen}
        onError={onError}
        onLink={onLink}
        linkPrompt={
          pendingLink ? (
            <div
              role="alert"
              className="mt-1 flex shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-[#161619] px-3 py-1.5 text-[12px] text-[#a0a0a8]"
              data-testid="html-visual-link"
            >
              <span className="min-w-0 flex-1 truncate">
                Open <span className="text-[#ececef]">{linkLabel(pendingLink)}</span> in your browser?
              </span>
              <button
                type="button"
                onClick={openLink}
                className="rounded-md bg-[#4d8dff] px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-[#3d7cf0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]/60"
              >
                Open
              </button>
              <ToolButton label="Dismiss" onClick={() => setPendingLink(null)}>
                <X size={13} />
              </ToolButton>
            </div>
          ) : null
        }
      />
      {errors.shown.length ? (
        <div role="status" className="mt-1 space-y-0.5 px-2">
          {errors.shown.map((message) => (
            <p key={message} className="break-words font-mono text-[11px] leading-snug text-[#a0a0a8]">
              Visual error: {message}
            </p>
          ))}
          {errors.more ? <p className="font-mono text-[11px] text-[#a0a0a8]">+{errors.more} more</p> : null}
        </div>
      ) : null}
      {sourceOpen ? (
        <div className="relative mt-2 overflow-hidden rounded-lg border border-white/10 bg-[#141416]">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5 text-[11px] text-[#a0a0a8]">
            <span className="truncate">{visual.title} · HTML</span>
            <ToolButton label={copied ? 'Copied' : 'Copy source'} onClick={copySource}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </ToolButton>
          </div>
          <pre className="max-h-[360px] overflow-auto p-3 font-mono text-[11.5px] leading-relaxed text-[#cfcfd4]">
            <code>{visual.html}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
};
