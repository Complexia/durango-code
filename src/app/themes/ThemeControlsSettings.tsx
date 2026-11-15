import React from 'react';
import { Play, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import type { ThemeControl, ThemeControlPlacement, ThemeValue, ThemeValueSpec, UiTheme } from '../../ui-themes.js';
import { fireThemeAction, resetThemeValues, setThemeValues, useThemeValues } from './themeState';

/**
 * Settings → Themes → Controls: the active theme's values (what its own
 * controls change) as plain settings, where each of its controls sits in the
 * app, its action buttons, and Reset to the theme's defaults.
 */

const SLOT_NAMES: Record<string, string> = {
  'titlebar-left': 'title bar, by the logo',
  'titlebar-center': 'title bar, after the thread title',
  'titlebar-right': 'title bar, right side',
  'sidebar-top': 'sidebar, top row',
  'sidebar-bottom': 'sidebar footer',
  'composer-toolbar': 'prompt box toolbar',
  'composer-top': 'prompt box, above the text',
  'thread-header': 'split pane headers',
};

const KIND_NAMES: Record<ThemeControl['kind'], string> = {
  toggle: 'Toggle',
  choice: 'Switcher',
  slider: 'Slider',
  menu: 'Menu',
  button: 'Button',
  html: 'Widget',
};

/** Where a control is, in words: "Toggle in the title bar, right side". */
export const describeControlPlace = (placement: ThemeControlPlacement) => {
  const corner = (placement.corner ?? 'top-right').replace('-', ' ');
  if (placement.position === 'float') {
    if (placement.slot) return `floating over the ${SLOT_NAMES[placement.slot] ?? placement.slot}, ${corner}`;
    if (placement.selector) return `floating over ${placement.selector}, ${corner}`;
    return `floating over the window, ${corner}`;
  }
  if (placement.slot) return `in the ${SLOT_NAMES[placement.slot] ?? placement.slot}`;
  const where = { before: 'before', after: 'after', start: 'at the start of', end: 'at the end of' }[placement.position] ?? 'next to';
  return `${where} ${placement.selector}`;
};

const ValueInput: React.FC<{ theme: UiTheme; name: string; spec: ThemeValueSpec; value: ThemeValue }> = ({ theme, name, spec, value }) => {
  if (spec.type === 'boolean') {
    return (
      <label className="provider-toggle" title={spec.label ?? name}>
        <input type="checkbox" checked={value === true} onChange={(event) => setThemeValues(theme, { [name]: event.target.checked })} />
        <span />
      </label>
    );
  }
  if (spec.type === 'number') {
    const step = spec.step ?? (spec.max - spec.min <= 2 ? 0.01 : 1);
    const number = Number(value);
    return (
      <div className="flex shrink-0 items-center gap-2">
        <input
          type="range"
          min={spec.min}
          max={spec.max}
          step={step}
          value={number}
          aria-label={spec.label ?? name}
          className="w-[140px] cursor-pointer accent-[var(--accent)]"
          onChange={(event) => setThemeValues(theme, { [name]: Number(event.currentTarget.value) })}
        />
        <span className="w-10 text-right text-[12px] tabular-nums text-[var(--text-secondary)]">{Math.round(number * 100) / 100}</span>
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label={spec.label ?? name} className="flex shrink-0 flex-wrap justify-end gap-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] p-0.5">
      {spec.options.map((option) => {
        const selected = option.value === String(value);
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setThemeValues(theme, { [name]: option.value })}
            className={`rounded-[calc(var(--radius-sm)-2px)] px-2.5 py-1 text-[12px] font-medium transition ${
              selected
                ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            }`}
          >
            {option.label ?? option.value}
          </button>
        );
      })}
    </div>
  );
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const ThemeControlsSettings: React.FC<{ theme: UiTheme }> = ({ theme }) => {
  const values = useThemeValues(theme.id);
  const specs = Object.entries(theme.values ?? {});
  const controls = theme.controls ?? [];
  if (!specs.length && !controls.length) return null;
  const changed = specs.some(([name, spec]) => values[name] !== undefined && values[name] !== spec.default);
  const others = controls.filter((control) => !control.value);

  const reset = async () => {
    const error = await resetThemeValues(theme);
    if (error) toast.error(error);
  };

  return (
    <>
      <div className="settings-group-label flex items-center justify-between">
        <span>{theme.name} controls</span>
        {specs.length > 0 && (
          <button
            type="button"
            disabled={!changed}
            onClick={() => void reset()}
            title="Return every value to the theme's default"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40"
          >
            <RotateCcw size={12} /> Reset to defaults
          </button>
        )}
      </div>
      <div className="settings-group">
        {specs.map(([name, spec]) => {
          const value = values[name] ?? spec.default;
          const places = controls.filter((control) => control.value === name);
          return (
            <div className="setting-row" key={name}>
              <div className="setting-label">
                <div className="setting-label-title">{spec.label ?? capitalize(name.replace(/-/g, ' '))}</div>
                <div className="setting-label-desc">
                  {places.length
                    ? places.map((control) => `${KIND_NAMES[control.kind]} ${describeControlPlace(control.placement)}`).join(' · ')
                    : 'No control in the app; the theme uses it on its own.'}
                </div>
              </div>
              <ValueInput theme={theme} name={name} spec={spec} value={value} />
            </div>
          );
        })}
        {others.map((control) => (
          <div className="setting-row" key={control.id}>
            <div className="setting-label">
              <div className="setting-label-title">{control.label ?? control.tooltip ?? capitalize(control.id.replace(/-/g, ' '))}</div>
              <div className="setting-label-desc">
                {KIND_NAMES[control.kind]} {describeControlPlace(control.placement)}
                {control.kind === 'button' && control.set
                  ? ` · sets ${Object.entries(control.set)
                      .map(([name, value]) => `${name} to ${String(value)}`)
                      .join(', ')}`
                  : ''}
              </div>
            </div>
            {control.kind === 'button' ? (
              <button
                type="button"
                className="provider-auth-button"
                onClick={() => {
                  if (control.set) setThemeValues(theme, control.set);
                  if (control.action) fireThemeAction(control.action, { control: control.id });
                }}
              >
                <Play size={12} /> Run
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-1.5 px-1 text-[12px] text-[var(--text-muted)]">
        Ask an agent to add, move or restyle controls. Your choices are kept with each theme.
      </p>
    </>
  );
};

export default ThemeControlsSettings;
