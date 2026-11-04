import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronUp,
  Globe,
  Hand,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RotateCw,
  Square,
  User,
  X,
} from 'lucide-react';
import type { BrowserTab } from './useBrowserTabs';

// The corner preview: a thumbnail of the selected tab (CSS px).
const MINI_WIDTH = 320;
// Minimized: only the title bar, so it covers less of the thread.
const MINIMIZED_WIDTH = 260;
const MINI_MARGIN = 16;
// Thumbnail refresh: faster while the page is moving.
const THUMB_BUSY_MS = 1000;
const THUMB_IDLE_MS = 2500;
const THUMB_HIDDEN_MS = 4000;

// Anything drawn above the panel's area: the native view would cover it, so
// the view hides while one of these overlaps the placeholder.
const OVERLAY_SELECTOR = [
  '.modal-backdrop',
  '.modal',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.review-popover',
  '.task-picker-popover',
  '.slash-popover',
  '.codex-settings-popover',
  '.access-mode-popover',
  '.composer-menu-panel',
  '.shell-openwith-menu',
  '.thread-menu',
  '.file-drop-overlay',
  '.terminal-overlay',
].join(',');

const intersects = (a: DOMRect, b: DOMRect) =>
  a.width > 0 && a.height > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const hostOf = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'about:' ? 'New tab' : parsed.host || parsed.href;
  } catch {
    return url || 'New tab';
  }
};

type BrowserPanelProps = {
  tabs: BrowserTab[];
  selectedTabId: string | null;
  onSelectTab: (tabId: string | null) => void;
  focusedThreadId: string | null;
  focusedProjectPath: string | null;
  ownerLabel: (tab: BrowserTab) => string;
  /** Expanded: a modal with the live page; otherwise a preview in the corner. */
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  /** Minimized: the corner preview shows only its title bar (tabs keep running). */
  minimized: boolean;
  onMinimizedChange: (minimized: boolean) => void;
  onClose: () => void;
};

export const BrowserPanel = ({
  tabs,
  selectedTabId,
  onSelectTab,
  focusedThreadId,
  focusedProjectPath,
  ownerLabel,
  expanded,
  onExpand,
  onCollapse,
  minimized,
  onMinimizedChange,
  onClose,
}: BrowserPanelProps) => {
  const api = window.orion?.browser;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const [covered, setCovered] = useState(false);
  const [miniBottom, setMiniBottom] = useState(MINI_MARGIN);
  const [thumb, setThumb] = useState<{ tabId: string; src: string } | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [editingUrl, setEditingUrl] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const tab = useMemo(() => tabs.find((candidate) => candidate.id === selectedTabId) ?? null, [tabs, selectedTabId]);

  // Keep the URL field on the page's URL unless the person is typing.
  useEffect(() => {
    if (!editingUrl) setUrlDraft(tab?.url && tab.url !== 'about:blank' ? tab.url : '');
  }, [tab?.url, tab?.id, editingUrl]);
  useEffect(() => {
    setPromptText(tab?.dialog?.defaultPrompt ?? '');
  }, [tab?.dialog?.message, tab?.dialog?.defaultPrompt]);
  useEffect(() => setError(null), [tab?.id]);

  // ---- Native view placement ----
  const syncBounds = useCallback(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder || !api) return;
    const rect = placeholder.getBoundingClientRect();
    void api.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }, [api]);

  useLayoutEffect(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder) return undefined;
    syncBounds();
    const observer = new ResizeObserver(() => syncBounds());
    observer.observe(placeholder);
    window.addEventListener('resize', syncBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [syncBounds, tab?.id, expanded]);

  // Hide the view under menus, popovers and dialogs that overlap it.
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      // The corner preview sits above any composer it would cover.
      const right = window.innerWidth - MINI_MARGIN;
      const left = right - MINI_WIDTH;
      let bottom = MINI_MARGIN;
      for (const composer of document.querySelectorAll('.composer-shell')) {
        const rect = composer.getBoundingClientRect();
        if (!rect.width || rect.right <= left || rect.left >= right) continue;
        const areaElement = composer.closest('.chat-input-area') ?? composer;
        areaObserver.observe(areaElement);
        const area = areaElement.getBoundingClientRect();
        bottom = Math.max(bottom, Math.round(window.innerHeight - area.top + 8));
      }
      setMiniBottom(bottom);
      const placeholder = placeholderRef.current;
      if (!placeholder) return;
      const area = placeholder.getBoundingClientRect();
      let overlap = false;
      for (const element of document.querySelectorAll(OVERLAY_SELECTOR)) {
        if (panelRef.current?.contains(element)) continue;
        if (intersects(element.getBoundingClientRect(), area)) {
          overlap = true;
          break;
        }
      }
      setCovered(overlap);
      syncBounds();
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    // Composers grow while typing without adding nodes.
    const areaObserver = new ResizeObserver(schedule);
    window.addEventListener('resize', schedule);
    check();
    return () => {
      observer.disconnect();
      areaObserver.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [syncBounds, expanded]);

  const visible = expanded && Boolean(tab) && !covered && !tab?.crashed;
  useEffect(() => {
    void api?.select(tab?.id ?? null);
  }, [api, tab?.id]);
  useEffect(() => {
    void api?.setVisible(visible);
  }, [api, visible]);
  useEffect(() => () => void api?.setVisible(false), [api]);

  // ---- Corner preview thumbnail ----
  const tabId = tab?.id ?? null;
  const pageBusy = Boolean(tab?.loading || tab?.agentBusy);
  const canThumb = !expanded && !minimized && Boolean(tabId) && !tab?.crashed && Boolean(api?.thumbnail);
  useEffect(() => {
    if (!canThumb || !tabId || !api?.thumbnail) return undefined;
    let cancelled = false;
    let timer = 0;
    let captured = false;
    const run = async () => {
      if (!document.hidden) {
        const result = await api.thumbnail!({ tabId, width: Math.round(MINI_WIDTH * (window.devicePixelRatio || 1)) });
        if (cancelled) return;
        if (result?.ok && result.dataUrl) {
          captured = true;
          setThumb({ tabId, src: result.dataUrl });
        }
      }
      // A page that has not painted yet is retried soon.
      const delay = document.hidden ? THUMB_HIDDEN_MS : !captured ? 400 : pageBusy ? THUMB_BUSY_MS : THUMB_IDLE_MS;
      timer = window.setTimeout(run, delay);
    };
    timer = window.setTimeout(run, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, canThumb, tabId, pageBusy, tab?.url, tab?.lastAgentActionAt]);

  // Escape closes the modal (focus in the page itself keeps Escape there).
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Escape in a field (the address bar resets itself) stays there.
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return;
      onCollapse();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, onCollapse]);

  // ---- Actions ----
  const report = (result: OrionBrowserResult | undefined) => {
    if (result && !result.ok && result.error) setError(result.error);
  };
  const openNewTab = async (url?: string) => {
    if (!api) return;
    const result = await api.create({ url, projectPath: focusedProjectPath, threadId: focusedThreadId });
    report(result);
    if (result?.tabId) onSelectTab(result.tabId);
  };
  const submitUrl = async (event: React.FormEvent) => {
    event.preventDefault();
    const url = urlDraft.trim();
    setEditingUrl(false);
    if (!url) return;
    if (!tab) {
      await openNewTab(url);
      return;
    }
    setError(null);
    report(await api?.navigate({ tabId: tab.id, url }));
  };

  const agentTab = tab && tab.ownerKey !== 'user';
  const iconButton =
    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#a0a0a8] transition-colors hover:bg-white/[0.06] hover:text-[#ececef] disabled:pointer-events-none disabled:opacity-35';

  const tabLabel = tab ? tab.title || hostOf(tab.url) : 'No tab open';
  const attention = tab?.dialog
    ? `${hostOf(tab.dialog.url || tab.url)} is asking something`
    : tab?.pendingDownload
      ? `Wants to download ${tab.pendingDownload.filename}`
      : null;

  if (!expanded) {
    const thumbSrc = thumb && thumb.tabId === tab?.id ? thumb.src : null;
    return (
      <div
        ref={panelRef}
        className="browser-mini fixed z-[90] overflow-hidden rounded-xl border border-white/[0.09] bg-[#141416] shadow-[0_16px_48px_rgba(0,0,0,0.55)]"
        style={{ right: MINI_MARGIN, bottom: miniBottom, width: minimized ? MINIMIZED_WIDTH : MINI_WIDTH }}
        aria-label="Browser preview"
      >
        <div
          className={`flex h-8 items-center gap-1.5 pl-2.5 pr-1 text-[12px] ${minimized ? 'cursor-pointer' : 'border-b border-white/[0.055]'}`}
          onClick={minimized ? () => onMinimizedChange(false) : undefined}
          title={minimized ? 'Show preview' : undefined}
        >
          {!tab ? (
            <Globe size={12} className="shrink-0 text-[#6b6b74]" />
          ) : agentTab ? (
            <Bot size={12} className={tab.agentBusy ? 'shrink-0 animate-pulse text-[#4d8dff]' : 'shrink-0 text-[#8b7cf6]'} />
          ) : (
            <User size={12} className="shrink-0 text-[#6b6b74]" />
          )}
          <span className="min-w-0 flex-1 truncate text-[#ececef]" title={tab ? `${tabLabel} · ${ownerLabel(tab)}` : undefined}>
            {tabLabel}
          </span>
          {minimized && attention && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#f4a261]" title={attention} />}
          {tabs.length > 1 && <span className="shrink-0 text-[11px] tabular-nums text-[#6b6b74]">{tabs.length} tabs</span>}
          {minimized ? (
            <button
              type="button"
              className={iconButton}
              title="Show preview"
              aria-label="Show browser preview"
              onClick={(event) => {
                event.stopPropagation();
                onMinimizedChange(false);
              }}
            >
              <ChevronUp size={14} />
            </button>
          ) : (
            <button type="button" className={iconButton} title="Minimize" aria-label="Minimize browser" onClick={() => onMinimizedChange(true)}>
              <Minus size={14} />
            </button>
          )}
          <button
            type="button"
            className={iconButton}
            title="Expand"
            aria-label="Expand browser"
            onClick={(event) => {
              event.stopPropagation();
              onExpand();
            }}
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            className={iconButton}
            title="Close browser"
            aria-label="Close browser"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <X size={14} />
          </button>
        </div>
        {!minimized && (
          <button
            type="button"
            className="group relative block aspect-[16/10] w-full cursor-zoom-in overflow-hidden bg-[#101012] text-left"
            aria-label="Expand browser"
            onClick={onExpand}
          >
            {thumbSrc ? (
              <img src={thumbSrc} alt="" draggable={false} className="h-full w-full object-cover object-top" />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-[#6b6b74]">
                {!tab ? 'Open a page' : tab.crashed ? 'This page crashed' : 'Loading…'}
              </span>
            )}
            <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-[opacity,background-color] duration-150 group-hover:bg-black/35 group-hover:opacity-100">
              <span className="flex items-center gap-1.5 rounded-md bg-black/70 px-2.5 py-1 text-[12px] text-white">
                <Maximize2 size={12} /> Expand
              </span>
            </span>
            {(attention || (tab && agentTab)) && (
              <span
                className={`absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] backdrop-blur ${
                  attention
                    ? 'bg-[#f4a261]/90 text-[#1a1208]'
                    : tab?.controller === 'user'
                      ? 'bg-[#0f2a20]/85 text-[#a7f3d0]'
                      : 'bg-[#1c1830]/85 text-[#c9c1ff]'
                }`}
              >
                {attention ? null : tab?.controller === 'user' ? <Hand size={11} className="shrink-0" /> : <Bot size={11} className={tab?.agentBusy ? 'shrink-0 animate-pulse' : 'shrink-0'} />}
                <span className="truncate">{attention ?? (tab?.controller === 'user' ? "You're in control" : 'Agent is controlling')}</span>
              </span>
            )}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="browser-modal-backdrop fixed inset-0 z-[1050] flex items-center justify-center bg-[rgb(8_8_10/62%)] p-6 sm:p-10"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCollapse();
      }}
    >
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Browser"
      className="flex h-full max-h-[1200px] w-full max-w-[1680px] flex-col overflow-hidden rounded-xl border border-white/[0.09] bg-[#141416] shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
    >

      {/* Tab strip */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/[0.055] px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Browser tabs">
          {tabs.map((candidate) => {
            const active = candidate.id === selectedTabId;
            const agentOwned = candidate.ownerKey !== 'user';
            return (
              <div
                key={candidate.id}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                onClick={() => onSelectTab(candidate.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelectTab(candidate.id);
                }}
                title={`${candidate.title || hostOf(candidate.url)} · ${ownerLabel(candidate)}`}
                className={`group flex h-7 min-w-[92px] max-w-[190px] cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] ${
                  active ? 'bg-white/[0.08] text-[#ececef]' : 'text-[#a0a0a8] hover:bg-white/[0.04]'
                }`}
              >
                {agentOwned ? (
                  <Bot size={12} className={candidate.agentBusy ? 'shrink-0 text-[#4d8dff]' : 'shrink-0 text-[#8b7cf6]'} />
                ) : (
                  <User size={12} className="shrink-0 text-[#6b6b74]" />
                )}
                <span className="min-w-0 flex-1 truncate">{candidate.title || hostOf(candidate.url)}</span>
                {candidate.dialog && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#f4a261]" />}
                <button
                  type="button"
                  aria-label={`Close ${candidate.title || 'tab'}`}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-white/10 group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    void api?.close(candidate.id);
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <button type="button" className={iconButton} title="New tab" aria-label="New tab" onClick={() => void openNewTab()}>
          <Plus size={15} />
        </button>
        <button type="button" className={iconButton} title="Make small (Esc)" aria-label="Make browser small" onClick={onCollapse}>
          <Minimize2 size={14} />
        </button>
        <button type="button" className={iconButton} title="Close browser" aria-label="Close browser" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      {/* Toolbar */}
      <form className="flex h-10 shrink-0 items-center gap-1 border-b border-white/[0.055] px-1.5" onSubmit={submitUrl}>
        <button type="button" className={iconButton} aria-label="Back" title="Back" disabled={!tab?.canGoBack} onClick={() => tab && void api?.back(tab.id)}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className={iconButton} aria-label="Forward" title="Forward" disabled={!tab?.canGoForward} onClick={() => tab && void api?.forward(tab.id)}>
          <ArrowRight size={15} />
        </button>
        <button
          type="button"
          className={iconButton}
          aria-label={tab?.loading ? 'Stop' : 'Reload'}
          title={tab?.loading ? 'Stop' : 'Reload'}
          disabled={!tab}
          onClick={() => tab && void (tab.loading ? api?.stop(tab.id) : api?.reload(tab.id))}
        >
          {tab?.loading ? <Square size={13} /> : <RotateCw size={14} />}
        </button>
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#101012] px-2 focus-within:border-[#4d8dff]/60">
          <Globe size={12} className="shrink-0 text-[#6b6b74]" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[#ececef] outline-none placeholder:text-[#6b6b74]"
            value={urlDraft}
            placeholder="Enter a URL, e.g. localhost:3000"
            spellCheck={false}
            aria-label="Address"
            onFocus={(event) => {
              setEditingUrl(true);
              event.currentTarget.select();
            }}
            onBlur={() => setEditingUrl(false)}
            onChange={(event) => setUrlDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setEditingUrl(false);
                setUrlDraft(tab?.url ?? '');
                event.currentTarget.blur();
              }
            }}
          />
        </div>
      </form>

      {/* Control banner */}
      {tab && agentTab && (
        <div
          className={`flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.055] px-3 text-[12px] ${
            tab.controller === 'agent' ? 'bg-[#8b7cf6]/10 text-[#c9c1ff]' : 'bg-[#34d399]/10 text-[#a7f3d0]'
          }`}
        >
          {tab.controller === 'agent' ? (
            <>
              <Bot size={13} className={tab.agentBusy ? 'shrink-0 animate-pulse' : 'shrink-0'} />
              <span className="min-w-0 flex-1 truncate">
                Agent is controlling · {ownerLabel(tab)}
              </span>
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 px-2 py-0.5 text-[#ececef] hover:bg-white/10"
                onClick={() => void api?.takeControl(tab.id)}
              >
                <Hand size={12} /> Take over
              </button>
            </>
          ) : (
            <>
              <Hand size={13} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">You're in control · the agent waits</span>
              <button
                type="button"
                className="shrink-0 rounded-md border border-white/10 px-2 py-0.5 text-[#ececef] hover:bg-white/10"
                onClick={() => void api?.releaseControl(tab.id)}
              >
                Hand back
              </button>
            </>
          )}
        </div>
      )}
      {tab && !agentTab && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.055] px-3 text-[12px] text-[#a0a0a8]">
          <User size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">Your tab · agents can't use it</span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-white/10 px-2 py-0.5 text-[#ececef] hover:bg-white/10 disabled:opacity-40"
            disabled={!focusedThreadId}
            title={focusedThreadId ? 'Give this tab to the focused thread' : 'Focus a thread first'}
            onClick={async () => {
              if (!focusedThreadId) return;
              report(await api?.adopt({ tabId: tab.id, threadId: focusedThreadId, projectPath: focusedProjectPath }));
            }}
          >
            Let agent use
          </button>
        </div>
      )}

      {/* JavaScript dialog */}
      {tab?.dialog && (
        <div className="shrink-0 border-b border-white/[0.055] bg-[#f4a261]/10 px-3 py-2 text-[12px] text-[#ececef]">
          <div className="mb-1.5 text-[#f4a261]">
            {hostOf(tab.dialog.url || tab.url)} asks ({tab.dialog.type})
          </div>
          <div className="mb-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{tab.dialog.message}</div>
          {tab.dialog.type === 'prompt' && (
            <input
              className="mb-2 h-7 w-full rounded-md border border-white/10 bg-[#101012] px-2 text-[12px] outline-none focus:border-[#4d8dff]/60"
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
              aria-label="Dialog answer"
            />
          )}
          <div className="flex justify-end gap-2">
            {tab.dialog.type !== 'alert' && (
              <button
                type="button"
                className="rounded-md border border-white/10 px-2.5 py-0.5 hover:bg-white/10"
                onClick={() => void api?.answerDialog({ tabId: tab.id, dialogId: tab.dialog?.id, accept: false })}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className="rounded-md bg-[#4d8dff] px-2.5 py-0.5 text-white hover:bg-[#4d8dff]/85"
              onClick={() =>
                void api?.answerDialog({
                  tabId: tab.id,
                  dialogId: tab.dialog?.id,
                  accept: true,
                  ...(tab.dialog?.type === 'prompt' ? { promptText } : {}),
                })
              }
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Download waiting for the user (Ask before downloading) */}
      {tab?.pendingDownload && (
        <div className="shrink-0 border-b border-white/[0.055] bg-[#4d8dff]/10 px-3 py-2 text-[12px] text-[#ececef]">
          <div className="mb-2 break-words">
            <span className="text-[#8db4ff]">{hostOf(tab.pendingDownload.url || tab.url)}</span> wants to download{' '}
            <span className="font-medium">{tab.pendingDownload.filename}</span>
            {tab.pendingDownload.totalBytes ? ` (${formatBytes(tab.pendingDownload.totalBytes)})` : ''}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-white/10 px-2.5 py-0.5 hover:bg-white/10"
              onClick={() => void api?.answerDownload({ tabId: tab.id, id: tab.pendingDownload!.id, accept: false })}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-[#4d8dff] px-2.5 py-0.5 text-white hover:bg-[#4d8dff]/85"
              onClick={() => void api?.answerDownload({ tabId: tab.id, id: tab.pendingDownload!.id, accept: true })}
            >
              Save
            </button>
          </div>
        </div>
      )}

      {(error || tab?.blocked) && (
        <div className="flex shrink-0 items-start gap-2 border-b border-white/[0.055] bg-[#f87171]/10 px-3 py-1.5 text-[12px] text-[#fca5a5]">
          <span className="min-w-0 flex-1 break-words">{error ?? tab?.blocked}</span>
          {error && (
            <button type="button" aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100" onClick={() => setError(null)}>
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {/* The tab's native view is laid over this placeholder. */}
      <div ref={placeholderRef} className="relative min-h-0 flex-1 bg-white">
        {!tab && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#101012] px-8 text-center">
            <Globe size={26} className="text-[#6b6b74]" />
            <div className="text-[13px] font-medium text-[#ececef]">No tab open</div>
            <div className="max-w-[300px] text-[12px] leading-relaxed text-[#6b6b74]">
              Agents open tabs here when they browse, and you can watch or take over. Type a URL above to open your own.
            </div>
          </div>
        )}
        {tab && covered && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#101012] text-[12px] text-[#6b6b74]">
            {tab.title || hostOf(tab.url)}
          </div>
        )}
        {tab?.crashed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#101012] text-[12px] text-[#a0a0a8]">
            This page crashed.
            <button type="button" className="rounded-md border border-white/10 px-2.5 py-1 hover:bg-white/10" onClick={() => void api?.reload(tab.id)}>
              Reload
            </button>
          </div>
        )}
      </div>
    </div>
    </div>
  );
};

export default BrowserPanel;
