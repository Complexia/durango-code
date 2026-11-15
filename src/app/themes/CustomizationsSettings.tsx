import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, MessageSquare, MoreHorizontal, Pencil, PartyPopper, RotateCcw, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import type { UiTheme } from '../../ui-themes.js';
import { ThemePreview } from './ThemePreview';
import { previewThemeCelebration } from './ThemeLayer';
import { runThemeAction, startThemeSync, useThemeState } from './themeState';

/**
 * Settings → Customizations: switch between themes (Stock, the built-ins and
 * the ones the user saved from threads), manage them, and start a new one by
 * asking an agent in a regular thread (src/main/theme-tools.js does the
 * restyling). Stock is always first and always one click away.
 */

const IDEAS: ReadonlyArray<{ label: string; prompt: string }> = [
  {
    label: 'AI wallpaper',
    prompt: 'Generate a moody, atmospheric wallpaper for Durango Code with Durango inference and build a matching palette around it.',
  },
  {
    label: 'Looping video backdrop',
    prompt: 'Make me a theme with a slow, looping AI-generated video backdrop of rain on a neon city window at night, with a palette to match.',
  },
  {
    label: 'Cozy and warm',
    prompt: 'Make Durango Code feel cozy: warm candlelit tones, soft rounded corners, and a gentle animated backdrop of drifting dust motes.',
  },
  {
    label: 'Celebrate finished turns',
    prompt: 'Keep my current look, but add a tasteful confetti burst over the app whenever an agent finishes a turn.',
  },
  {
    label: 'Light and airy',
    prompt: 'Make a light theme for Durango Code: paper-white surfaces, ink text, one crisp accent color, and keep everything readable.',
  },
];

const customizePrompt = (idea: string) =>
  `Customize how Durango Code looks: ${idea.trim()}\n\nRestyle the app live with the theme tools (get_app_theme, set_app_theme; generate_theme_media for AI-made backdrops), check it with a screenshot, and keep text readable.`;

type Props = {
  /** Opens a new thread with the prompt in its composer (App.tsx). */
  onCustomizeWithAgent?: (prompt: string) => void;
  /** Opens the thread a theme was made in. */
  onOpenThread?: (threadId: string) => void;
  /** Whether a thread exists here (to offer "Open thread"). */
  hasThread?: (threadId: string) => boolean;
};

const ThemeMenu: React.FC<{
  theme: UiTheme;
  onRename: () => void;
  onOpenThread?: () => void;
}> = ({ theme, onRename, onOpenThread }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const act = async (action: Parameters<typeof runThemeAction>[0], done?: string) => {
    setOpen(false);
    const error = await runThemeAction(action);
    if (error) toast.error(error);
    else if (done) toast.success(done);
  };
  const item =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]';
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        aria-label={`More for ${theme.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-7 z-30 w-44 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-md)]"
          onClick={(event) => event.stopPropagation()}
        >
          {!theme.builtIn && (
            <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onRename(); }}>
              <Pencil size={13} /> Rename
            </button>
          )}
          <button type="button" role="menuitem" className={item} onClick={() => void act((api) => api.duplicate(theme.id), `Made a copy of “${theme.name}”`)}>
            <Copy size={13} /> Duplicate
          </button>
          {onOpenThread && (
            <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onOpenThread(); }}>
              <MessageSquare size={13} /> Open its thread
            </button>
          )}
          {!theme.builtIn && theme.saved && (
            <button type="button" role="menuitem" className={item} onClick={() => void act((api) => api.setSaved(theme.id, false))}>
              <Check size={13} /> Unsave
            </button>
          )}
          {!theme.builtIn && (
            <button
              type="button"
              role="menuitem"
              className={`${item} hover:!text-[var(--danger)]`}
              onClick={() => void act((api) => api.remove(theme.id), `Deleted “${theme.name}”`)}
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const ThemeTile: React.FC<{
  theme: UiTheme | null;
  active: boolean;
  onApply: () => void;
  badge?: string;
  menu?: React.ReactNode;
  renaming?: boolean;
  onRenamed?: (name: string | null) => void;
  extra?: React.ReactNode;
}> = ({ theme, active, onApply, badge, menu, renaming, onRenamed, extra }) => {
  const [draft, setDraft] = useState(theme?.name ?? '');
  useEffect(() => setDraft(theme?.name ?? ''), [theme?.name, renaming]);
  const name = theme ? theme.name : 'Stock';
  const description = theme ? theme.description : 'The original Durango Code look.';
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={() => !renaming && onApply()}
      onKeyDown={(event) => {
        if (renaming) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onApply();
        }
      }}
      className={`group flex cursor-pointer flex-col rounded-[var(--radius-lg)] border bg-[var(--bg-raised)] text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
        active
          ? 'border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-soft)]'
          : 'border-[var(--border-default)] hover:border-[var(--border-strong)]'
      }`}
    >
      {/* The card does not clip, so its ⋯ menu can hang below it; the preview rounds its own corners. */}
      <ThemePreview theme={theme} className="aspect-[16/10] w-full rounded-t-[calc(var(--radius-lg)-1px)]" />
      <div className="flex min-h-[58px] items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {renaming ? (
              <input
                autoFocus
                value={draft}
                maxLength={60}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') onRenamed?.(draft.trim() || null);
                  if (event.key === 'Escape') onRenamed?.(null);
                }}
                onBlur={() => onRenamed?.(draft.trim() || null)}
                className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            ) : (
              <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{name}</span>
            )}
            {active && !renaming && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
            {badge && !renaming && (
              <span className="shrink-0 rounded-full border border-[var(--border-default)] px-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                {badge}
              </span>
            )}
          </div>
          {description && <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-[var(--text-muted)]">{description}</div>}
          {extra}
        </div>
        {menu}
      </div>
    </div>
  );
};

export const CustomizationsSettings: React.FC<Props> = ({ onCustomizeWithAgent, onOpenThread, hasThread }) => {
  const snapshot = useThemeState((state) => state.snapshot);
  const animate = useThemeState((state) => state.animate);
  const setAnimate = useThemeState((state) => state.setAnimate);
  const [idea, setIdea] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);

  useEffect(() => startThemeSync(), []);

  const activeId = snapshot?.activeId ?? null;
  const themes = snapshot?.themes ?? [];
  const builtIns = themes.filter((theme) => theme.builtIn);
  const saved = themes.filter((theme) => !theme.builtIn && theme.saved).reverse();
  const activeDraft = themes.find((theme) => theme.id === activeId && !theme.builtIn && !theme.saved) ?? null;
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  const apply = async (id: string | null) => {
    const error = await runThemeAction((api) => api.setActive(id));
    if (error) toast.error(error);
  };

  const start = (text: string) => {
    if (!text.trim() || !onCustomizeWithAgent) return;
    onCustomizeWithAgent(customizePrompt(text));
    setIdea('');
  };

  const userTile = (theme: UiTheme, badge?: string, extra?: React.ReactNode) => (
    <ThemeTile
      key={theme.id}
      theme={theme}
      active={activeId === theme.id}
      onApply={() => void apply(theme.id)}
      badge={badge}
      extra={extra}
      renaming={renamingId === theme.id}
      onRenamed={(name) => {
        setRenamingId(null);
        if (name && name !== theme.name) {
          void runThemeAction((api) => api.rename(theme.id, name)).then((error) => error && toast.error(error));
        }
      }}
      menu={
        <ThemeMenu
          theme={theme}
          onRename={() => setRenamingId(theme.id)}
          onOpenThread={
            theme.threadId && onOpenThread && (hasThread?.(theme.threadId) ?? true)
              ? () => onOpenThread(theme.threadId as string)
              : undefined
          }
        />
      }
    />
  );

  return (
    <div className="customizations-settings">
      <div className="relative mb-2 mt-1 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-default)] bg-[var(--bg-raised)] p-5">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(60% 120% at 0% 0%, var(--accent-soft), transparent 70%), radial-gradient(50% 120% at 100% 100%, color-mix(in srgb, var(--agent-violet) 16%, transparent), transparent 70%)',
          }}
        />
        <div className="relative">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--text-primary)]">
            <Wand2 size={16} className="text-[var(--accent)]" /> Make Durango Code yours
          </div>
          <p className="mt-1 max-w-[560px] text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            Describe a look and an agent restyles the app live in a new thread: colors, fonts, animated scenes that react
            while agents work, and wallpapers or looping video made with Durango inference. Turn Save on in the thread to
            keep it here.
          </p>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              start(idea);
            }}
          >
            <input
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="A misty pine forest at dawn, soft greens, a slow fog drifting behind everything…"
              className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
            <button
              type="submit"
              disabled={!idea.trim() || !onCustomizeWithAgent}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-2 text-[12.5px] font-semibold text-[var(--on-accent)] transition hover:brightness-110 disabled:opacity-40"
            >
              <Sparkles size={13} /> Customize with an agent
            </button>
          </form>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {IDEAS.map((entry) => (
              <button
                key={entry.label}
                type="button"
                onClick={() => onCustomizeWithAgent?.(customizePrompt(entry.prompt))}
                className="rounded-full border border-[var(--border-default)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="settings-group-label flex items-center justify-between">
        <span>Themes</span>
        {activeId && (
          <button
            type="button"
            onClick={() => void apply(null)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <RotateCcw size={12} /> Back to stock
          </button>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
        <ThemeTile theme={null} active={!activeId} onApply={() => void apply(null)} badge="Original" />
        {activeDraft &&
          userTile(
            activeDraft,
            'Unsaved',
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void runThemeAction((api) => api.setSaved(activeDraft.id, true)).then((error) =>
                  error ? toast.error(error) : toast.success(`Saved “${activeDraft.name}”`)
                );
              }}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--accent)] hover:brightness-125"
            >
              <Check size={11} /> Save theme
            </button>
          )}
        {saved.map((theme) => userTile(theme))}
      </div>
      {saved.length === 0 && !activeDraft && (
        <p className="mt-2 px-1 text-[12px] text-[var(--text-muted)]">
          Themes you save from a thread show up here.
        </p>
      )}

      <div className="settings-group-label">Prebuilt</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
        {builtIns.map((theme) => (
          <ThemeTile
            key={theme.id}
            theme={theme}
            active={activeId === theme.id}
            onApply={() => void apply(theme.id)}
            menu={<ThemeMenu theme={theme} onRename={() => {}} />}
          />
        ))}
      </div>

      <div className="settings-group-label">Effects</div>
      <div className="settings-group">
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">Animated backdrops and effects</div>
            <div className="setting-label-desc">
              Play themes' animated scenes and video. Off shows a still frame and hides overlays.
            </div>
          </div>
          <label className="provider-toggle" title="Animated backdrops and effects">
            <input type="checkbox" checked={animate} onChange={(event) => setAnimate(event.target.checked)} />
            <span />
          </label>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">Preview celebration</div>
            <div className="setting-label-desc">
              Play what the current theme does when an agent finishes a turn.
            </div>
          </div>
          <button
            type="button"
            className="provider-auth-button"
            disabled={!activeId}
            onClick={() => previewThemeCelebration()}
          >
            <PartyPopper size={13} /> Preview
          </button>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">Back to stock, anytime</div>
            <div className="setting-label-desc">
              {isMac ? '⌘⌥⇧0' : 'Ctrl+Alt+Shift+0'} returns to the original look from anywhere, even if a theme hides
              this page.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CustomizationsSettings;
