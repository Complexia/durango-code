import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { AppUpdateState } from './appTypes';
import { ConfirmModal } from './ConfirmDialog';

// The app update's surfaces besides the sidebar button itself: the hover card
// with what changed, the confirmation before restarting into the update, and
// the "What's new" notice on the first launch of a new version.

// Release notes are Markdown, one change per line (`- **Title:** text with
// `code` and [links](https://…)`). Each note renders its inline Markdown only:
// emphasis, code and links. Block elements (the paragraph, a stray quote or
// list) are unwrapped to their text so a note stays one tight list item, and
// raw HTML is never rendered.
const releaseNoteElements = ['strong', 'em', 'del', 'code', 'a', 'br'];
const releaseNoteRemarkPlugins = [remarkGfm];

// Links open in the default browser; anything but http(s) stays plain text.
const ReleaseNoteLink: React.FC<React.ComponentPropsWithoutRef<'a'> & ExtraProps> = ({
  href,
  children,
  node: _node,
  ...props
}) => {
  if (!href || !/^https?:\/\//i.test(href)) return <>{children}</>;
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!window.orion) return;
    void window.orion
      .openExternalUrl(href)
      .then((result) => {
        if (!result.ok) toast.error(result.error ?? 'Could not open the link.');
      })
      .catch(() => toast.error('Could not open the link.'));
  };
  return (
    <a {...props} href={href} title={href} onClick={handleClick}>
      {children}
    </a>
  );
};

const releaseNoteComponents = { a: ReleaseNoteLink };

export const ReleaseNoteText: React.FC<{ note: string }> = React.memo(({ note }) => (
  <ReactMarkdown
    remarkPlugins={releaseNoteRemarkPlugins}
    allowedElements={releaseNoteElements}
    unwrapDisallowed
    skipHtml
    components={releaseNoteComponents}
  >
    {note}
  </ReactMarkdown>
));

export const ReleaseNotesList: React.FC<{ notes: string[]; className?: string }> = ({ notes, className }) => (
  <ul
    className={`release-notes-list m-0 list-disc space-y-1.5 pl-[18px] text-[12.5px] leading-[1.45] text-neutral-300 ${className ?? ''}`}
  >
    {notes.map((note, index) => (
      <li key={`${index}-${note}`} className="pl-0.5 marker:text-neutral-500">
        <ReleaseNoteText note={note} />
      </li>
    ))}
  </ul>
);

const HOVER_OPEN_DELAY_MS = 120;
const HOVER_CLOSE_DELAY_MS = 160;

const hoverCardHeading = (state: AppUpdateState, percent: number) => {
  const version = state.availableVersion ? `v${state.availableVersion}` : 'A new version';
  switch (state.status) {
    case 'downloading':
      return { title: `Downloading update (${percent}%)`, detail: null };
    case 'downloaded':
      return { title: `${version} is ready to install`, detail: 'Click to restart Durango Code and install it.' };
    case 'restarting':
      return { title: 'Restarting to update…', detail: null };
    case 'error':
      return { title: 'Update failed', detail: state.error ?? 'Click to try again.' };
    default:
      return { title: `Update available: ${version}`, detail: 'Click to download it.' };
  }
};

// Wraps the update button: hovering or focusing it opens a card above it with
// the update's status and release notes. The card is portaled so the
// sidebar's overflow cannot clip it, and stays open while the pointer is over
// it so a long list can be scrolled.
export const AppUpdateHoverCard: React.FC<{
  state: AppUpdateState;
  percent: number;
  children: React.ReactNode;
}> = ({ state, percent, children }) => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const schedule = useCallback((next: boolean) => {
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(next), next ? HOVER_OPEN_DELAY_MS : HOVER_CLOSE_DELAY_MS);
  }, []);
  useEffect(() => clearTimer, []);

  useLayoutEffect(() => {
    if (!open || !wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    setAnchor({ left: Math.max(8, rect.left), bottom: window.innerHeight - rect.top + 8 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const heading = hoverCardHeading(state, percent);
  const notes = state.releaseNotes ?? [];

  return (
    <span
      ref={wrapperRef}
      className="inline-flex"
      onMouseEnter={() => schedule(true)}
      onMouseLeave={() => schedule(false)}
      onFocus={() => schedule(true)}
      onBlur={() => schedule(false)}
    >
      {children}
      {open &&
        anchor &&
        createPortal(
          <div
            role="tooltip"
            data-testid="app-update-hover-card"
            className="fixed z-[1050] flex max-h-[min(560px,calc(100vh-96px))] w-[360px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-lg border border-white/10 bg-[rgb(20_20_22_/_0.98)] text-neutral-200 shadow-2xl backdrop-blur-md"
            style={{ left: anchor.left, bottom: anchor.bottom }}
            onMouseEnter={() => schedule(true)}
            onMouseLeave={() => schedule(false)}
          >
            <div className="flex flex-col gap-1 px-4 pb-3 pt-3.5">
              <div className="text-[13.5px] font-semibold text-neutral-100">{heading.title}</div>
              {heading.detail && (
                <div
                  className={`text-[12px] leading-snug ${state.status === 'error' ? 'text-red-300' : 'text-neutral-400'}`}
                >
                  {heading.detail}
                </div>
              )}
              {state.status === 'downloading' && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-[rgb(139_130_255)]" style={{ width: `${percent}%` }} />
                </div>
              )}
            </div>
            {notes.length > 0 && (
              <div className="min-h-0 overflow-y-auto border-t border-white/[0.06] px-4 pb-4 pt-3">
                <div className="mb-2 text-[12px] font-semibold text-neutral-300">What&apos;s changed</div>
                <ReleaseNotesList notes={notes} />
              </div>
            )}
          </div>,
          document.body
        )}
    </span>
  );
};

// Restarting quits every running agent, so ask first.
export const RestartToUpdateDialog: React.FC<{
  version: string | null | undefined;
  runningThreadCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ version, runningThreadCount, onCancel, onConfirm }) => (
  <ConfirmModal
    title={`Install update${version ? ` ${version}` : ''} and restart Durango Code?`}
    description={
      <>
        Any running tasks will be interrupted. Make sure you&apos;re ready before continuing.
        {runningThreadCount > 0 &&
          ` ${runningThreadCount} ${runningThreadCount === 1 ? 'thread is' : 'threads are'} running right now.`}
      </>
    }
    confirmLabel="Confirm"
    cancelLabel="Cancel"
    testId="restart-to-update-dialog"
    onCancel={onCancel}
    onConfirm={onConfirm}
  />
);

// Shown once on the first launch of a new version, in the corner the update
// button lives in, until the user clicks OK.
export const WhatsNewNotice: React.FC<{
  version: string;
  notes: string[];
  onDismiss: () => void;
}> = ({ version, notes, onDismiss }) => (
  <div
    role="dialog"
    aria-labelledby="whats-new-title"
    data-testid="whats-new-notice"
    className="fixed bottom-14 left-3 z-[80] flex max-h-[min(520px,calc(100vh-96px))] w-[360px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-white/10 bg-[rgb(20_20_22_/_0.97)] text-neutral-200 shadow-2xl backdrop-blur-md"
  >
    <div className="flex items-start gap-3 px-4 pb-3 pt-4">
      <Sparkles size={16} className="mt-0.5 shrink-0 text-[rgb(139_130_255)]" aria-hidden />
      <div className="min-w-0">
        <div id="whats-new-title" className="text-[13.5px] font-semibold text-neutral-100">
          Durango Code updated to v{version}
        </div>
        {notes.length === 0 && (
          <div className="mt-1 text-[12px] text-neutral-400">You&apos;re on the latest version.</div>
        )}
      </div>
    </div>
    {notes.length > 0 && (
      <div className="min-h-0 overflow-y-auto px-4 pb-1 pl-11">
        <div className="mb-2 text-[12px] font-semibold text-neutral-300">What&apos;s new</div>
        <ReleaseNotesList notes={notes} />
      </div>
    )}
    <div className="flex justify-end px-4 pb-4 pt-3">
      <button
        type="button"
        className="rounded-md bg-[rgb(139_130_255)] px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-[rgb(156_148_255)]"
        onClick={onDismiss}
        autoFocus
      >
        OK
      </button>
    </div>
  </div>
);
