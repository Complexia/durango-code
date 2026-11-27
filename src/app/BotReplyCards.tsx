import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, FileText, GitMerge, Loader2, MessageCircleQuestion, MessageSquare, Paperclip, Reply, SendHorizontal, X } from 'lucide-react';
import { toast } from 'sonner';
import { useOrionStore } from '../store';
import { imageFileNamePattern, localMediaSrc, videoFileNamePattern } from './attachments';
import { HtmlVisual } from './HtmlVisual';
import { handleLightboxImageClick } from './imageLightbox';
import { botActionLabel, botShipRequestText, formatFileSize, parseBotAction, type BotAction, type BotCard, type BotFileLink, type BotMessageFile } from './bots';

// What a bot reply shows besides its text (chat/docs/bots.md → "Rich replies"),
// with the pieces normal threads use: files as thumbnails that open in the
// image viewer, show_html pages in the same sandboxed frame as a thread's
// visuals (HtmlVisual), and buttons (show_actions) and questions (ask_user).
// Cards are Durango Chat's ui parts `{ id, component, props }`, from Durango
// (signed in) or this device's bots (signed out).

// --- library files: read links by id, kept while fresh -------------------------------------

const LINK_FRESH_MS = 45 * 60_000; // links last an hour
const links = new Map<string, { link: BotFileLink; at: number }>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let queued: string[] = [];
let flushTimer: number | null = null;

const flush = async () => {
  flushTimer = null;
  const ids = queued.splice(0, 40);
  if (queued.length) flushTimer = window.setTimeout(() => void flush(), 0);
  const result = await window.orion?.botFileLinks?.({ ids }).catch(() => null);
  const now = Date.now();
  for (const link of result?.files ?? []) links.set(link.id, { link, at: now });
  for (const id of ids) pending.delete(id);
  listeners.forEach((listener) => listener());
};

const request = (ids: string[]) => {
  const now = Date.now();
  const missing = ids.filter((id) => !pending.has(id) && (links.get(id)?.at ?? 0) < now - LINK_FRESH_MS);
  if (!missing.length) return;
  missing.forEach((id) => pending.add(id));
  queued.push(...missing);
  // One request for every card that mounts in the same tick.
  if (flushTimer === null) flushTimer = window.setTimeout(() => void flush(), 0);
};

/** Read links for library files (ids), loaded once and kept while fresh. */
export const useBotFileLinks = (ids: string[]) => {
  const key = ids.join(',');
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!key) return undefined;
    const listener = () => setTick((tick) => tick + 1);
    listeners.add(listener);
    request(key.split(','));
    return () => {
      listeners.delete(listener);
    };
  }, [key]);
  return useMemo(() => {
    const map = new Map<string, BotFileLink>();
    for (const id of ids) {
      const entry = links.get(id);
      if (entry) map.set(id, entry.link);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, links.size, ...ids.map((id) => links.get(id)?.at ?? 0)]);
};

// --- files ----------------------------------------------------------------------------------

/** A file to show: a link (signed in) or a path on this device (signed out). */
export type ShownFile = { key: string; name: string; size?: number; contentType?: string; url?: string; path?: string; loading?: boolean };

const isImage = (file: ShownFile) =>
  /^image\/(png|jpe?g|gif|webp|avif|apng|svg\+xml)$/i.test(file.contentType ?? '') || imageFileNamePattern.test(file.name);
const isVideo = (file: ShownFile) => /^video\//i.test(file.contentType ?? '') || videoFileNamePattern.test(file.name);
const srcOf = (file: ShownFile) => file.url ?? (file.path ? localMediaSrc(file.path, []) : undefined);

const openFile = (file: ShownFile) => {
  if (file.url) {
    void window.orion?.openExternalUrl(file.url).then((result) => {
      if (!result.ok) toast.error(result.error ?? 'Could not open the file.');
    });
  } else if (file.path) {
    void window.orion?.openLinkedFile?.({ href: file.path, baseDirs: [] }).then((result) => {
      if (!result?.ok) toast.error(result?.error ?? 'Could not open the file.');
    });
  }
};

/**
 * Files under a message: images as thumbnails that open full size (arrows step
 * through the message's images), videos as players, anything else as a chip.
 */
export const BotFileGallery: React.FC<{ files: ShownFile[]; align?: 'start' | 'end' }> = ({ files, align = 'start' }) => {
  if (!files.length) return null;
  const media = files.filter((file) => (isImage(file) || isVideo(file)) && (srcOf(file) || file.loading));
  const others = files.filter((file) => !media.includes(file));
  const justify = align === 'end' ? 'justify-end' : 'justify-start';
  return (
    <div className={`bot-files mt-1.5 flex max-w-full flex-col gap-1.5 ${align === 'end' ? 'items-end' : 'items-start'}`} data-lightbox-scope="">
      {media.length > 0 && (
        <div className={`flex max-w-full flex-wrap gap-1.5 ${justify}`}>
          {media.map((file) => {
            const src = srcOf(file);
            if (!src) {
              return (
                <span key={file.key} className="flex h-[120px] w-[180px] items-center justify-center rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08]">
                  <Loader2 size={14} className="animate-spin text-neutral-500" />
                </span>
              );
            }
            return isVideo(file) ? (
              <video key={file.key} src={src} controls preload="metadata" title={file.name} className="max-h-[260px] max-w-[360px] rounded-xl ring-1 ring-white/[0.08]" />
            ) : (
              <img
                key={file.key}
                src={src}
                alt={file.name}
                title={file.name}
                loading="lazy"
                data-lightbox=""
                onClick={handleLightboxImageClick}
                className={`${media.length === 1 ? 'max-h-[320px] max-w-[min(100%,480px)]' : 'max-h-[180px] max-w-[260px]'} cursor-zoom-in rounded-xl object-cover ring-1 ring-white/[0.08]`}
              />
            );
          })}
        </div>
      )}
      {others.length > 0 && (
        <div className={`flex max-w-full flex-wrap gap-1.5 ${justify}`}>
          {others.map((file) => {
            const clickable = Boolean(file.url || file.path);
            return (
              <button
                key={file.key}
                type="button"
                disabled={!clickable}
                onClick={() => openFile(file)}
                title={clickable ? `Open ${file.name}` : file.name}
                className="inline-flex max-w-[260px] items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[12px] text-neutral-300 ring-1 ring-white/[0.08] transition-colors duration-75 enabled:hover:bg-white/[0.09] disabled:cursor-default"
              >
                <Paperclip size={12} className="shrink-0 text-neutral-500" />
                <span className="truncate">{file.name}</span>
                {file.size ? <span className="shrink-0 text-neutral-500">{formatFileSize(file.size)}</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** A message's own files (what the person sent, or a signed-out reply's), with links for library ones. */
export const useMessageFiles = (files: BotMessageFile[] | undefined): ShownFile[] => {
  const ids = (files ?? []).flatMap((file) => (file.assetId && !file.path ? [file.assetId] : []));
  const linked = useBotFileLinks(ids);
  return (files ?? []).map((file, index) => {
    const link = file.assetId ? linked.get(file.assetId) : undefined;
    return {
      key: `${file.assetId ?? file.path ?? file.name}-${index}`,
      name: file.name,
      size: file.size,
      contentType: file.contentType ?? link?.contentType,
      ...(file.path ? { path: file.path } : link ? { url: link.url } : {}),
      loading: Boolean(file.assetId && !file.path && !link),
    };
  });
};

type GalleryProps = { assets?: { id?: unknown; name?: unknown; kind?: unknown }[] };

/** asset-gallery: library files a reply attached. */
const AssetGalleryCard: React.FC<{ props: GalleryProps }> = ({ props }) => {
  const assets = (Array.isArray(props.assets) ? props.assets : [])
    .filter((asset): asset is { id: string; name?: unknown; kind?: unknown } => typeof asset?.id === 'string')
    .slice(0, 24);
  const linked = useBotFileLinks(assets.map((asset) => asset.id));
  const files: ShownFile[] = assets.map((asset) => {
    const link = linked.get(asset.id);
    const name = typeof asset.name === 'string' ? asset.name : link?.name ?? 'file';
    const kind = typeof asset.kind === 'string' ? asset.kind : '';
    return {
      key: asset.id,
      name,
      size: link?.byteSize,
      contentType: link?.contentType || (kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : undefined),
      url: link?.url,
      loading: !link,
    };
  });
  return <BotFileGallery files={files} />;
};

// --- HTML pages -------------------------------------------------------------------------------

const HTML_HEIGHTS: Record<string, number> = { sm: 260, md: 420, lg: 640 };

/** html (show_html): the same sandboxed frame a thread's visuals use. */
const HtmlCard: React.FC<{ props: Record<string, unknown> }> = ({ props }) => {
  const html = typeof props.html === 'string' ? props.html : '';
  const title = typeof props.title === 'string' ? props.title : 'Visual';
  const height = typeof props.height === 'string' ? HTML_HEIGHTS[props.height] : undefined;
  const visual = useMemo(() => ({ html, title, ...(height ? { height } : {}) }), [html, title, height]);
  if (!html) return null;
  return (
    <div className="bot-card-html mt-2">
      <HtmlVisual visual={visual} />
      {typeof props.description === 'string' && props.description ? (
        <div className="mt-1 text-[11.5px] text-neutral-500">{props.description}</div>
      ) : null}
    </div>
  );
};

// --- buttons ----------------------------------------------------------------------------------

export type BotActionHandlers = {
  /** Sends text as the person's next message. */
  onReply: (text: string) => void;
  /** Opens a Durango Code thread here (false: not on this computer). */
  onOpenThread: (threadId: string) => boolean;
  /** Dismisses an ask_user question card without answering or starting a bot turn. Returns false on failure. */
  onDismissAsk?: (target: { messageId?: string; partId?: string; question: string }) => Promise<boolean> | boolean | void;
};

const ACTION_ICONS = { ship_change: GitMerge, open_change: ExternalLink, open_thread: MessageSquare, open_url: ExternalLink, reply: Reply } as const;

const BUTTON =
  'inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium ring-1 transition-colors duration-75 disabled:cursor-default disabled:opacity-50';
const BUTTON_PLAIN = `${BUTTON} bg-white/[0.05] text-neutral-200 ring-white/[0.1] enabled:hover:bg-white/[0.09]`;
const BUTTON_PRIMARY = `${BUTTON} bg-sky-500/90 text-white ring-sky-400/40 enabled:hover:bg-sky-500`;

const landedChanges = new Map<string, 'landing' | 'landed' | 'sent'>();

/**
 * Ship: asks to confirm in place, then ships the change through the Durango
 * Code thread that made it (the bots' Shipping rule: that thread knows how its
 * project ships). The thread here: the ship request goes to it as a follow-up.
 * A thread on another machine: the bot is asked to send it there. No thread
 * known: it lands the change the way the thread header's Land does.
 */
const ShipButton: React.FC<{ action: BotAction; handlers: BotActionHandlers; onSent: (text: string) => void }> = ({ action, handlers, onSent }) => {
  const changeId = action.change_id ?? '';
  const threadId = action.thread_id;
  const [state, setState] = useState<'idle' | 'confirm' | 'landing' | 'landed' | 'sent'>(() => landedChanges.get(changeId) ?? 'idle');
  const viaBot = () => {
    const text = botShipRequestText(action);
    landedChanges.set(changeId, 'sent');
    setState('sent');
    onSent(text);
    handlers.onReply(text);
  };
  const ship = async () => {
    setState('landing');
    landedChanges.set(changeId, 'landing');
    if (threadId) {
      const sent = await window.orion
        ?.shipBotChange?.({ changeId, threadId })
        .catch((error: unknown) => ({ ok: false as const, error: String(error) }));
      if (sent?.ok) {
        landedChanges.set(changeId, 'sent');
        setState('sent');
        toast.success(`Sent ${changeId} to the thread that made it`, {
          description: 'It ships the change its project’s way.',
          action: { label: 'Open thread', onClick: () => void handlers.onOpenThread(threadId) },
        });
        return;
      }
      if (sent && 'notHere' in sent && sent.notHere) {
        // On another machine: the bot routes it there (delegate_task thread_id).
        viaBot();
        return;
      }
      landedChanges.delete(changeId);
      setState('idle');
      toast.error(`Could not send ${changeId} to its thread`, { description: sent?.error ?? 'Durango Code could not start the follow-up.' });
      return;
    }
    toast.info(`Landing ${changeId}…`);
    const result = await window.orion?.shipBotChange?.({ changeId }).catch((error: unknown) => ({ ok: false as const, error: String(error) }));
    if (result?.ok) {
      landedChanges.set(changeId, 'landed');
      setState('landed');
      const url = result.url ?? action.url;
      toast.success(`${result.changeId ?? changeId} is merged`, {
        ...(url ? { action: { label: 'Open', onClick: () => void window.orion?.openExternalUrl(url) } } : {}),
      });
      return;
    }
    landedChanges.delete(changeId);
    setState('idle');
    toast.error(result && 'exitCode' in result && result.exitCode === 3 ? 'The change conflicts with main' : `Could not land ${changeId}`, {
      description: result?.error ?? 'Durango Code could not run the land.',
    });
  };
  if (state === 'confirm') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] py-0.5 pl-2.5 pr-0.5 text-[12.5px] text-neutral-300 ring-1 ring-sky-400/30">
        {threadId ? `Ship ${changeId}? The thread that made it ships it its project’s way.` : `Land ${changeId}? It merges into main and deploys.`}
        <button type="button" className={BUTTON_PRIMARY} onClick={() => void ship()} autoFocus>
          <GitMerge size={13} /> {threadId ? 'Ship' : 'Land'}
        </button>
        <button type="button" className={BUTTON_PLAIN} onClick={() => setState('idle')}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={BUTTON_PRIMARY}
      disabled={state !== 'idle' || !window.orion?.shipBotChange}
      onClick={() => setState('confirm')}
      title={threadId ? `Ship ${changeId} through the thread that made it: you confirm first` : `Land ${changeId}: you confirm first`}
    >
      {state === 'landing' ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />}
      {state === 'landing'
        ? threadId
          ? 'Sending…'
          : 'Landing…'
        : state === 'landed'
          ? 'Shipped'
          : state === 'sent'
            ? 'Sent to thread'
            : botActionLabel(action)}
    </button>
  );
};

const ActionButton: React.FC<{ action: BotAction; handlers: BotActionHandlers; sent: string | null; onSent: (text: string) => void }> = ({
  action,
  handlers,
  sent,
  onSent,
}) => {
  if (action.kind === 'ship_change') return <ShipButton action={action} handlers={handlers} onSent={onSent} />;
  const Icon = ACTION_ICONS[action.kind];
  const label = botActionLabel(action);
  const run = () => {
    switch (action.kind) {
      case 'reply': {
        const text = action.text ?? action.label ?? '';
        if (!text) return;
        onSent(text);
        handlers.onReply(text);
        return;
      }
      case 'open_thread':
        if (action.thread_id && !handlers.onOpenThread(action.thread_id)) toast.error("That thread isn't on this computer.");
        return;
      case 'open_change':
        void window.orion?.openBotChange?.({ changeId: action.change_id ?? '', ...(action.url ? { url: action.url } : {}) }).then((result) => {
          if (!result.ok) toast.error(result.error ?? 'Could not open the change.');
        });
        return;
      case 'open_url':
        if (action.url) {
          void window.orion?.openExternalUrl(action.url).then((result) => {
            if (!result.ok) toast.error(result.error ?? 'Could not open the link.');
          });
        }
        return;
    }
  };
  const chosen = action.kind === 'reply' && sent !== null && sent === (action.text ?? action.label);
  return (
    <button
      type="button"
      className={`${BUTTON_PLAIN}${chosen ? ' ring-sky-400/50' : ''}`}
      disabled={action.kind === 'reply' && sent !== null}
      onClick={run}
      title={action.kind === 'open_url' ? action.url : action.kind === 'reply' ? `Send “${action.text ?? action.label}”` : undefined}
    >
      <Icon size={13} className="shrink-0 text-neutral-400" />
      {label}
    </button>
  );
};

/** Buttons under a reply (show_actions), or on a task report (its thread and change). */
export const BotActionsRow: React.FC<{ actions: BotAction[]; title?: string; handlers: BotActionHandlers }> = ({ actions, title, handlers }) => {
  const [sent, setSent] = useState<string | null>(null);
  if (!actions.length) return null;
  return (
    <div className="bot-card-actions mt-2">
      {title ? <div className="mb-1.5 text-[12.5px] text-neutral-400">{title}</div> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {actions.map((action, index) => (
          <ActionButton key={`${action.kind}-${index}`} action={action} handlers={handlers} sent={sent} onSent={setSent} />
        ))}
      </div>
    </div>
  );
};

// --- questions (ask_user) --------------------------------------------------------------------

/** The message a picked or typed answer sends (Durango's lib/bots/ui.ts botAskAnswer; the person's bubble shows it as an answer). */
export const botAskAnswer = (question: string, option: string) =>
  `> **Answering:** ${question.replace(/\s+/g, ' ').trim()}\n\n${option.trim()}`;

export const AskCard: React.FC<{
  props: Record<string, unknown>;
  handlers: BotActionHandlers;
  answered?: string | null;
  messageId?: string;
  partId?: string;
}> = ({ props, handlers, answered, messageId, partId }) => {
  const question = typeof props.question === 'string' ? props.question : '';
  const options = (Array.isArray(props.options) ? props.options : []).filter((option): option is string => typeof option === 'string').slice(0, 6);
  const recommended = typeof props.recommended === 'number' ? props.recommended : -1;
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [localDismissed, setLocalDismissed] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chosen = picked ?? answered ?? null;
  const isDismissed = chosen === null && (localDismissed || props.dismissed === true);
  const customChosen = chosen !== null && !options.includes(chosen);
  const trimmedDraft = draft.trim();
  const canSend = chosen === null && !isDismissed && trimmedDraft.length > 0;
  const canDismiss = chosen === null && !isDismissed && Boolean(handlers.onDismissAsk);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  }, [draft]);

  if (!question || !options.length) return null;

  const submitCustom = () => {
    if (!canSend) return;
    setPicked(trimmedDraft);
    setDraft('');
    handlers.onReply(botAskAnswer(question, trimmedDraft));
  };

  const cancelCustom = () => {
    setDraft('');
    inputRef.current?.blur();
  };

  const dismiss = async () => {
    if (!canDismiss || dismissing || !handlers.onDismissAsk) return;
    setDismissing(true);
    setLocalDismissed(true);
    setDraft('');
    try {
      const ok = await handlers.onDismissAsk({ ...(messageId ? { messageId } : {}), ...(partId ? { partId } : {}), question });
      if (ok === false) setLocalDismissed(false);
    } catch {
      setLocalDismissed(false);
    } finally {
      setDismissing(false);
    }
  };

  if (isDismissed) {
    return (
      <div
        data-ask-dismissed=""
        className="bot-card-ask bot-card-ask-dismissed mt-2 flex max-w-[520px] items-center gap-2 rounded-xl bg-white/[0.02] px-3 py-2 text-[12px] text-neutral-500 ring-1 ring-white/[0.06]"
      >
        <MessageCircleQuestion size={13} className="shrink-0 text-neutral-500/80" />
        <span className="min-w-0 flex-1 truncate">{question}</span>
        <span className="shrink-0 text-[11px] text-neutral-500/80">Dismissed</span>
      </div>
    );
  }

  return (
    <div className="bot-card-ask mt-2 max-w-[520px] rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.08]">
      <div className="flex items-start gap-2 text-[13px] font-medium text-neutral-100">
        <MessageCircleQuestion size={14} className="mt-0.5 shrink-0 text-sky-400" />
        <span className="min-w-0 flex-1">{question}</span>
        {canDismiss ? (
          <button
            type="button"
            title="Dismiss question"
            aria-label="Dismiss question"
            disabled={dismissing}
            onClick={() => void dismiss()}
            className="-mr-1 -mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors duration-75 hover:bg-white/[0.08] hover:text-neutral-100 disabled:opacity-40"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {options.map((option, index) => (
          <button
            key={`${index}-${option}`}
            type="button"
            disabled={chosen !== null}
            onClick={() => {
              setPicked(option);
              setDraft('');
              handlers.onReply(botAskAnswer(question, option));
            }}
            className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] ring-1 transition-colors duration-75 ${
              chosen === option
                ? 'bg-sky-500/10 text-neutral-100 ring-sky-400/40'
                : chosen
                  ? 'cursor-default text-neutral-500 ring-white/[0.06]'
                  : 'text-neutral-200 ring-white/[0.08] hover:bg-white/[0.05]'
            }`}
          >
            <span>{option}</span>
            {chosen === option ? (
              <Check size={13} className="shrink-0 text-sky-400" />
            ) : recommended === index && !chosen ? (
              <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-sky-400">Suggested</span>
            ) : null}
          </button>
        ))}
      </div>
      {customChosen ? (
        <div
          data-ask-custom-answer=""
          className="mt-1.5 flex items-start justify-between gap-2 rounded-lg bg-sky-500/10 px-2.5 py-1.5 text-[12.5px] text-neutral-100 ring-1 ring-sky-400/40"
        >
          <span className="min-w-0 whitespace-pre-wrap break-words">{chosen}</span>
          <Check size={13} className="mt-0.5 shrink-0 text-sky-400" />
        </div>
      ) : null}
      {chosen === null ? (
        <div className="mt-1.5 flex items-end gap-1 rounded-lg bg-black/20 p-1 pl-2.5 ring-1 ring-white/[0.08] transition-colors duration-75 focus-within:bg-black/30 focus-within:ring-sky-400/50">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="Or type your own answer…"
            aria-label={`Answer “${question}”`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitCustom();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelCustom();
              }
            }}
            className="max-h-28 min-h-[24px] flex-1 resize-none bg-transparent py-0.5 text-[12.5px] leading-[20px] text-neutral-100 outline-none placeholder:text-neutral-500"
          />
          {draft ? (
            <button
              type="button"
              title="Cancel (Esc)"
              aria-label="Cancel answer"
              onClick={cancelCustom}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors duration-75 hover:bg-white/[0.06] hover:text-neutral-200"
            >
              <X size={12.5} />
            </button>
          ) : null}
          <button
            type="button"
            title="Send answer (Enter)"
            aria-label="Send answer"
            disabled={!canSend}
            onClick={submitCustom}
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors duration-75 ${
              canSend ? 'bg-sky-500 text-white hover:bg-sky-400' : 'text-neutral-500 opacity-50 disabled:cursor-default'
            }`}
          >
            <SendHorizontal size={12.5} />
          </button>
        </div>
      ) : null}
    </div>
  );
};

// --- every card -------------------------------------------------------------------------------

const CARD_NAMES: Record<string, string> = {
  chart: 'A chart',
  stats: 'Stats',
  progress: 'Progress',
  table: 'A table',
  timeline: 'A timeline',
  checklist: 'A checklist',
  calculator: 'A calculator',
  flashcards: 'Flashcards',
  quiz: 'A quiz',
  comparison: 'A comparison',
};

/** A card this app has no view for (Durango Chat's charts, tables…): named, with where to see it. */
const OtherCard: React.FC<{ card: BotCard }> = ({ card }) => {
  const props = (card.props ?? {}) as Record<string, unknown>;
  const title = typeof props.title === 'string' ? props.title : '';
  return (
    <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-neutral-400 ring-1 ring-white/[0.07]">
      <FileText size={12} className="shrink-0" />
      <span className="truncate">
        {CARD_NAMES[card.component] ?? 'A card'}
        {title ? ` · ${title}` : ''}
      </span>
      <span className="shrink-0 text-neutral-600">on durango.sh</span>
    </div>
  );
};

/** The cards under one reply, in the order the reply showed them. */
export const BotCards: React.FC<{
  cards: BotCard[];
  handlers: BotActionHandlers;
  answeredQuestions?: ReadonlyMap<string, string>;
  messageId?: string;
}> = ({ cards, handlers, answeredQuestions, messageId }) => (
  <>
    {cards.map((card) => {
      const props = (card.props && typeof card.props === 'object' ? card.props : {}) as Record<string, unknown>;
      switch (card.component) {
        case 'asset-gallery':
          return <AssetGalleryCard key={card.id} props={props as GalleryProps} />;
        case 'html':
          return <HtmlCard key={card.id} props={props} />;
        case 'bot-actions': {
          const actions = (Array.isArray(props.actions) ? props.actions : []).map(parseBotAction).filter((action): action is BotAction => Boolean(action)).slice(0, 6);
          return <BotActionsRow key={card.id} actions={actions} title={typeof props.title === 'string' ? props.title : undefined} handlers={handlers} />;
        }
        case 'bot-ask': {
          const question = typeof props.question === 'string' ? props.question.replace(/\s+/g, ' ').trim() : '';
          return (
            <AskCard
              key={card.id}
              props={props}
              handlers={handlers}
              answered={answeredQuestions?.get(question) ?? null}
              messageId={messageId}
              partId={card.id}
            />
          );
        }
        default:
          return <OtherCard key={card.id} card={card} />;
      }
    })}
  </>
);

/** Whether a thread is on this computer, for Open thread. */
export const threadIsHere = (threadId: string) => useOrionStore.getState().threads.some((thread) => thread.id === threadId);
