import React, { useEffect, useState } from 'react';
import { Check, Palette, RotateCcw, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ThemeSummary } from '../../ui-themes.js';
import { ThemePreview } from './ThemePreview';
import { runThemeAction, useThemeById, useThemeState } from './themeState';

/**
 * The card set_app_theme / generate_theme_media leave in the transcript
 * (src/main/theme-tools.js): the theme as it is now, with Save (keeps it in
 * Settings → Themes), Use, Undo and Stock. A thread's cards follow
 * its one working theme, so every card shows the latest look. On a computer
 * without the theme (another machine's thread) it shows the summary only.
 */
export const ThemeCard: React.FC<{ summary: ThemeSummary; note?: string; compact?: boolean }> = ({
  summary,
  note,
  compact = false,
}) => {
  const theme = useThemeById(summary.id);
  const activeId = useThemeState((state) => state.snapshot?.activeId ?? null);
  const loaded = useThemeState((state) => state.snapshot !== null);
  const [canUndo, setCanUndo] = useState(false);
  const active = activeId === summary.id;
  const revision = theme?.revision;

  useEffect(() => {
    if (!theme || theme.builtIn) return;
    let cancelled = false;
    void window.orion?.themes?.canUndo(theme.id).then((result) => {
      if (!cancelled) setCanUndo(result.ok && result.value === true);
    });
    return () => {
      cancelled = true;
    };
  }, [theme, revision]);

  const act = async (action: Parameters<typeof runThemeAction>[0]) => {
    const error = await runThemeAction(action);
    if (error) toast.error(error);
  };

  const features = [
    summary.backdrop === 'html' ? 'animated backdrop' : summary.backdrop ? `${summary.backdrop} backdrop` : null,
    summary.overlay ? 'effects overlay' : null,
    summary.controls ? `${summary.controls} control${summary.controls === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  if (compact) {
    return (
      <div className="theme-card-compact my-1 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
        <Palette size={12} />
        <span>
          Updated <span className="text-[var(--text-secondary)]">{summary.name}</span>
        </span>
        <span className="flex items-center gap-0.5">
          {summary.swatches.map((color, index) => (
            <span key={`${color}-${index}`} className="h-2 w-2 rounded-full" style={{ background: color }} />
          ))}
        </span>
        {note && <span className="truncate">· {note}</span>}
      </div>
    );
  }

  return (
    <div className="theme-card my-2 flex max-w-[560px] gap-3 rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-2.5">
      {theme ? (
        <ThemePreview theme={theme} className="aspect-[16/10] w-[150px] shrink-0 rounded-[var(--radius-md)] border border-[var(--border-subtle)]" />
      ) : (
        <div className="flex aspect-[16/10] w-[150px] shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border-subtle)]" style={{ background: summary.swatches[0] }}>
          <Palette size={22} style={{ color: summary.swatches[2] }} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">{theme?.name ?? summary.name}</span>
              {active && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent-soft)] px-1.5 py-px text-[10.5px] font-medium text-[var(--accent)]">
                  <Check size={10} /> In use
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1">
              {summary.swatches.map((color, index) => (
                <span
                  key={`${color}-${index}`}
                  className="h-3 w-3 rounded-full border border-[var(--border-strong)]"
                  style={{ background: color }}
                />
              ))}
              {features.length > 0 && <span className="ml-1.5 truncate text-[11.5px] text-[var(--text-muted)]">{features.join(' · ')}</span>}
            </div>
          </div>
          {theme && !theme.builtIn && (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-[var(--text-secondary)]" title="Keep this theme in Settings → Themes">
              {theme.saved ? 'Saved' : 'Save'}
              <span className="provider-toggle">
                <input
                  type="checkbox"
                  checked={theme.saved}
                  onChange={(event) => {
                    const saved = event.target.checked;
                    void act((api) => api.setSaved(theme.id, saved));
                    if (saved) toast.success(`Saved “${theme.name}” to Settings → Themes`);
                  }}
                />
                <span />
              </span>
            </label>
          )}
        </div>
        {note && <div className="truncate text-[11.5px] text-[var(--text-muted)]">{note}</div>}
        {theme ? (
          <div className="mt-auto flex flex-wrap items-center gap-1.5">
            {!active && (
              <button type="button" className="theme-card-button theme-card-button-primary" onClick={() => void act((api) => api.setActive(theme.id))}>
                <Palette size={12} /> Use this theme
              </button>
            )}
            {canUndo && (
              <button type="button" className="theme-card-button" onClick={() => void act((api) => api.undo(theme.id))} title="Go back to this theme's previous version">
                <Undo2 size={12} /> Undo change
              </button>
            )}
            {active && (
              <button type="button" className="theme-card-button" onClick={() => void act((api) => api.setActive(null))} title="Back to the original look (Cmd/Ctrl+Alt+Shift+0)">
                <RotateCcw size={12} /> Back to stock
              </button>
            )}
          </div>
        ) : (
          loaded && <div className="mt-auto text-[11.5px] text-[var(--text-muted)]">This theme is not on this computer.</div>
        )}
      </div>
    </div>
  );
};

export default ThemeCard;
