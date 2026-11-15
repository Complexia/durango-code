import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ThemeControl, ThemeLook, ThemeOption, ThemeValue, UiTheme } from '../../ui-themes.js';
import { ThemeIcon, isKnownIcon } from './ThemeIcon';
import { ThemeSceneFrame } from './ThemeSceneFrame';
import { fireThemeAction, setThemeValues, useThemeValues } from './themeState';

/**
 * The active theme's own controls (theme.controls), anywhere in the app:
 *
 * - in a named slot the app renders for themes (ThemeSlot: title bar,
 *   sidebar, prompt box…), or next to / inside any element a CSS selector
 *   finds (`before`, `after`, `start`, `end`), as a host element the
 *   control is portalled into;
 * - or floating over the window or over an element, at one of its corners.
 *
 * Hosts are placed again whenever the app's DOM changes (a re-render can
 * drop or replace the element a control sits next to). Controls the app
 * draws (toggle, choice, slider, menu, button) change the theme's values,
 * which the theme's CSS, scenes and backdrop variants follow; an `html`
 * control is the theme's own widget in a sandboxed frame.
 */

const MAX_MATCHES = 8;
const PLACE_THROTTLE_MS = 120;
const FLOAT_POLL_MS = 500;
const OWN = '.theme-control-host, .theme-controls-float, .theme-control-menu';

type Placed = { key: string; id: string; host: HTMLElement; anchor: Element | null; sig: string };

/** What decides where a control's host goes; a change re-places it. */
const placementSig = (control: ThemeControl) => `${control.kind}|${JSON.stringify(control.placement)}`;

const report = (theme: UiTheme, message: string) => window.orion?.themes?.reportSceneError(theme.id, message);

const anchorsFor = (control: ThemeControl, theme: UiTheme, warned: Set<string>): Element[] => {
  const { slot, selector, all } = control.placement;
  let found: Element[] = [];
  if (slot) found = Array.from(document.querySelectorAll(`[data-theme-slot="${slot}"]`));
  else if (selector) {
    try {
      found = Array.from(document.querySelectorAll(selector));
    } catch {
      const key = `${control.id}:invalid`;
      if (!warned.has(key)) {
        warned.add(key);
        report(theme, `control ${control.id}: "${selector}" is not a valid CSS selector`);
      }
      return [];
    }
  } else return [];
  found = found.filter((element) => !element.closest(OWN));
  return all ? found.slice(0, MAX_MATCHES) : found.slice(0, 1);
};

const newHost = (control: ThemeControl, floating: boolean) => {
  const host = document.createElement(floating ? 'div' : 'span');
  host.className = floating ? 'theme-control-host theme-control-floating' : 'theme-control-host';
  host.dataset.themeControl = control.id;
  host.dataset.themeControlKind = control.kind;
  return host;
};

const inPlace = (host: HTMLElement, anchor: Element, position: string, inSlot: boolean) => {
  if (!host.isConnected || !anchor.isConnected) return false;
  if (inSlot || position === 'start' || position === 'end') return host.parentNode === anchor;
  return host.parentNode === anchor.parentNode;
};

const insert = (host: HTMLElement, anchor: Element, position: string, inSlot: boolean) => {
  if (inSlot || position === 'end') anchor.appendChild(host);
  else if (position === 'start') anchor.insertBefore(host, anchor.firstChild);
  else if (position === 'before') anchor.parentNode?.insertBefore(host, anchor);
  else anchor.parentNode?.insertBefore(host, anchor.nextSibling);
};

/** Where a floating control goes: a corner of its anchor (or the window), plus x/y. */
const floatStyle = (control: ThemeControl, anchor: Element | null): React.CSSProperties & Record<string, string> => {
  const rect = anchor ? anchor.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
  const corner = control.placement.corner ?? 'bottom-right';
  const x = control.placement.x ?? (anchor ? 0 : 16);
  const y = control.placement.y ?? (anchor ? 0 : 16);
  if (anchor && rect.width === 0 && rect.height === 0) return { display: 'none' };
  const shown = { display: '' };
  let left = rect.left + x;
  let top = rect.top + y;
  let transform = '';
  if (corner === 'top-right') {
    left = rect.right - x;
    transform = 'translateX(-100%)';
  } else if (corner === 'bottom-left') {
    top = rect.bottom - y;
    transform = 'translateY(-100%)';
  } else if (corner === 'bottom-right') {
    left = rect.right - x;
    top = rect.bottom - y;
    transform = 'translate(-100%, -100%)';
  } else if (corner === 'center') {
    left = rect.left + rect.width / 2 + x;
    top = rect.top + rect.height / 2 + y;
    transform = 'translate(-50%, -50%)';
  }
  return { ...shown, left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, transform };
};

/** Keeps every control's hosts where its placement says, as the app re-renders. */
const usePlacements = (theme: UiTheme, controls: ThemeControl[], floatLayer: HTMLElement | null) => {
  const [placed, setPlaced] = useState<Placed[]>([]);
  const registry = useRef(new Map<string, Placed>());
  const warned = useRef(new Set<string>());
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  // Only where controls go restarts placement; a new look or value does not
  // (an HTML widget keeps its frame).
  const placementKey = useMemo(() => controls.map((control) => `${control.id}=${placementSig(control)}`).join('\n'), [controls]);
  const floats = controls.some((control) => control.placement.position === 'float');

  useLayoutEffect(() => {
    if (!floatLayer) return undefined;
    const hosts = registry.current;
    let last: Placed[] = [];

    const place = () => {
      const theme = themeRef.current;
      const ordered = [...controlsRef.current].sort((a, b) => (a.placement.order ?? 0) - (b.placement.order ?? 0));
      const wanted = new Set<string>();
      const next: Placed[] = [];
      for (const control of ordered) {
        const { placement } = control;
        const floating = placement.position === 'float';
        const anchors = anchorsFor(control, theme, warned.current);
        const targets: Array<Element | null> = floating && !placement.slot && !placement.selector ? [null] : anchors;
        targets.forEach((anchor, index) => {
          const key = `${control.id}:${index}`;
          wanted.add(key);
          const sig = placementSig(control);
          let entry = hosts.get(key);
          if (!entry || entry.sig !== sig) {
            entry?.host.remove();
            entry = { key, id: control.id, host: newHost(control, floating), anchor: null, sig };
            hosts.set(key, entry);
          }
          if (floating) {
            if (entry.host.parentNode !== floatLayer) floatLayer.appendChild(entry.host);
            // A slot takes no box of its own (display: contents, or an empty
            // row): float over the element it sits in.
            const measured = anchor && placement.slot ? anchor.parentElement : anchor;
            Object.assign(entry.host.style, floatStyle(control, measured));
            entry.anchor = anchor;
          } else if (anchor) {
            const inSlot = Boolean(placement.slot);
            if (entry.anchor !== anchor || !inPlace(entry.host, anchor, placement.position, inSlot)) {
              insert(entry.host, anchor, placement.position, inSlot);
              entry.anchor = anchor;
            }
          }
          next.push(entry);
        });
      }
      for (const [key, entry] of hosts) {
        if (wanted.has(key)) continue;
        entry.host.remove();
        hosts.delete(key);
      }
      const changed = next.length !== last.length || next.some((entry, index) => entry !== last[index]);
      if (changed) {
        last = next;
        setPlaced(next);
      }
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRun = 0;
    const schedule = () => {
      if (timer) return;
      const wait = Math.max(0, PLACE_THROTTLE_MS - (Date.now() - lastRun));
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        place();
      }, wait);
    };
    place();
    const observer = new MutationObserver((records) => {
      // Our own hosts moving in and out are not news.
      for (const record of records) {
        const target = record.target as Element;
        if (target.closest?.(OWN)) continue;
        const own = (nodes: NodeList) =>
          Array.from(nodes).every((node) => node instanceof Element && (node.matches(OWN) || Boolean(node.closest(OWN))));
        if (record.addedNodes.length && !own(record.addedNodes)) return schedule();
        if (record.removedNodes.length && !own(record.removedNodes)) return schedule();
        if (!record.addedNodes.length && !record.removedNodes.length) return schedule();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const poll = floats ? setInterval(schedule, FLOAT_POLL_MS) : null;
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      window.removeEventListener('resize', schedule);
      for (const entry of hosts.values()) entry.host.remove();
      hosts.clear();
      setPlaced([]);
    };
  }, [placementKey, floats, floatLayer, theme.id]);

  return placed;
};

// --- the controls ---------------------------------------------------------------------

const Look: React.FC<{ look: ThemeLook; showLabel?: boolean; fallback?: string; size?: number }> = ({ look, showLabel, fallback, size }) => {
  const hasIcon = Boolean(look.svg || isKnownIcon(look.icon));
  const label = look.label ?? fallback;
  return (
    <>
      {hasIcon ? <ThemeIcon icon={look.icon} svg={look.svg} size={size} /> : null}
      {(showLabel || !hasIcon) && label ? <span className="theme-control-label">{label}</span> : null}
    </>
  );
};

const lookOf = (control: ThemeControl): ThemeLook => ({ icon: control.icon, svg: control.svg, label: control.label });
const merge = (base: ThemeLook, over: ThemeLook | undefined): ThemeLook => ({
  icon: over?.icon ?? (over?.svg ? undefined : base.icon),
  svg: over?.svg ?? (over?.icon ? undefined : base.svg),
  label: over?.label ?? base.label,
});

type ControlProps = { theme: UiTheme; control: ThemeControl; values: Record<string, ThemeValue> };

const tip = (control: ThemeControl, extra?: string) =>
  [control.tooltip ?? control.label ?? extra, control.tooltip ? extra : undefined].filter(Boolean).join(' · ') || undefined;

const Toggle: React.FC<ControlProps> = ({ theme, control, values }) => {
  const name = control.value!;
  const on = values[name] === true;
  const look = merge(lookOf(control), on ? control.on : control.off);
  const label = look.label ?? theme.values?.[name]?.label ?? control.id;
  return (
    <button
      type="button"
      className={`theme-control-button${on ? ' is-on' : ''}`}
      aria-pressed={on}
      aria-label={label}
      title={tip(control, `${label}: ${on ? 'on' : 'off'}`)}
      onClick={() => setThemeValues(theme, { [name]: !on })}
    >
      <Look look={look} showLabel={control.showLabel} fallback={label} />
    </button>
  );
};

const optionsOf = (theme: UiTheme, control: ThemeControl): ThemeOption[] => {
  const spec = theme.values?.[control.value!];
  return spec?.type === 'choice' ? spec.options : [];
};

const Choice: React.FC<ControlProps> = ({ theme, control, values }) => {
  const name = control.value!;
  const options = optionsOf(theme, control);
  const current = String(values[name]);
  if (control.style === 'segmented') {
    return (
      <span className="theme-control-segmented" role="radiogroup" aria-label={control.label ?? theme.values?.[name]?.label ?? name}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === current}
            className={`theme-control-button${option.value === current ? ' is-on' : ''}`}
            title={option.label ?? option.value}
            onClick={() => setThemeValues(theme, { [name]: option.value })}
          >
            <Look look={option} showLabel={control.showLabel} fallback={option.value} />
          </button>
        ))}
      </span>
    );
  }
  const index = Math.max(0, options.findIndex((option) => option.value === current));
  const option = options[index];
  const next = options[(index + 1) % Math.max(1, options.length)];
  const label = option?.label ?? option?.value ?? '';
  return (
    <button
      type="button"
      className="theme-control-button"
      aria-label={`${control.label ?? theme.values?.[name]?.label ?? name}: ${label}`}
      title={tip(control, `${label}${next && next !== option ? ` → ${next.label ?? next.value}` : ''}`)}
      onClick={() => next && setThemeValues(theme, { [name]: next.value })}
    >
      <Look look={merge(lookOf(control), option)} showLabel={control.showLabel} fallback={label} />
    </button>
  );
};

const Slider: React.FC<ControlProps> = ({ theme, control, values }) => {
  const name = control.value!;
  const spec = theme.values?.[name];
  if (spec?.type !== 'number') return null;
  const value = Number(values[name] ?? spec.default);
  const step = spec.step ?? (spec.max - spec.min <= 2 ? 0.01 : 1);
  const label = control.label ?? spec.label ?? name;
  const hasIcon = Boolean(control.svg || isKnownIcon(control.icon));
  return (
    <label className="theme-control-slider" title={tip(control, `${label}: ${Math.round(value * 100) / 100}`)}>
      {hasIcon ? <ThemeIcon icon={control.icon} svg={control.svg} /> : null}
      {control.showLabel || !hasIcon ? <span className="theme-control-label">{label}</span> : null}
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={step}
        value={value}
        aria-label={label}
        style={{ width: control.width ?? 96 }}
        onChange={(event) => setThemeValues(theme, { [name]: Number(event.currentTarget.value) })}
      />
    </label>
  );
};

const Menu: React.FC<ControlProps> = ({ theme, control, values }) => {
  const name = control.value!;
  const options = optionsOf(theme, control);
  const current = String(values[name]);
  const option = options.find((entry) => entry.value === current);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const below = rect.bottom + 6;
    const menuHeight = Math.min(320, options.length * 32 + 10);
    const top = below + menuHeight > window.innerHeight ? Math.max(8, rect.top - 6 - menuHeight) : below;
    setPosition({ left: Math.min(Math.max(8, rect.left), window.innerWidth - 208), top });
  }, [open, options.length]);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const label = control.label ?? theme.values?.[name]?.label ?? name;
  const triggerLook = control.icon || control.svg ? lookOf(control) : merge(lookOf(control), option);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`theme-control-button${open ? ' is-on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${option?.label ?? current}`}
        title={tip(control, `${label}: ${option?.label ?? current}`)}
        onClick={() => setOpen((value) => !value)}
      >
        <Look look={triggerLook} showLabel={control.showLabel} fallback={option?.label ?? current} />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className="theme-control-menu fixed z-[2147483100] min-w-[160px] max-w-[260px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-elevated)] p-1 shadow-[0_16px_48px_rgb(0_0_0_/_0.45)]"
              style={{ left: position.left, top: position.top, maxHeight: 320 }}
            >
              {options.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.value === current}
                  className={`flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[13px] ${
                    entry.value === current
                      ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                  }`}
                  onClick={() => {
                    setThemeValues(theme, { [name]: entry.value });
                    setOpen(false);
                  }}
                >
                  {entry.svg || isKnownIcon(entry.icon) ? <ThemeIcon icon={entry.icon} svg={entry.svg} size={14} /> : null}
                  <span className="truncate">{entry.label ?? entry.value}</span>
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  );
};

const ActionButton: React.FC<ControlProps> = ({ theme, control }) => {
  const label = control.label ?? control.action ?? control.id;
  return (
    <button
      type="button"
      className="theme-control-button"
      aria-label={label}
      title={tip(control, label)}
      onClick={() => {
        if (control.set) setThemeValues(theme, control.set);
        if (control.action) fireThemeAction(control.action, { control: control.id });
      }}
    >
      <Look look={lookOf(control)} showLabel={control.showLabel} fallback={label} />
    </button>
  );
};

const Widget: React.FC<ControlProps> = ({ theme, control }) => {
  const [size, setSize] = useState({ width: control.width ?? 28, height: control.height ?? 28 });
  useEffect(() => setSize({ width: control.width ?? 28, height: control.height ?? 28 }), [control.width, control.height]);
  return (
    <ThemeSceneFrame
      theme={theme}
      html={control.html ?? ''}
      role="widget"
      name={control.id}
      interactive
      onResize={setSize}
      className="theme-control-widget"
      style={{ width: size.width, height: size.height }}
      title={control.label ?? control.tooltip ?? control.id}
    />
  );
};

const ControlView: React.FC<ControlProps> = (props) => {
  switch (props.control.kind) {
    case 'toggle':
      return <Toggle {...props} />;
    case 'choice':
      return <Choice {...props} />;
    case 'slider':
      return <Slider {...props} />;
    case 'menu':
      return <Menu {...props} />;
    case 'button':
      return <ActionButton {...props} />;
    case 'html':
      return <Widget {...props} />;
    default:
      return null;
  }
};

/** Unknown icon names, once per theme revision, so the agent hears about them. */
const useIconReports = (theme: UiTheme) => {
  useEffect(() => {
    const unknown = new Set<string>();
    for (const control of theme.controls ?? []) {
      const looks: ThemeLook[] = [control, control.on ?? {}, control.off ?? {}];
      if (control.value && theme.values?.[control.value]?.type === 'choice') {
        const spec = theme.values[control.value];
        if (spec.type === 'choice') looks.push(...spec.options);
      }
      for (const look of looks) if (look.icon && !look.svg && !isKnownIcon(look.icon)) unknown.add(`${control.id}: "${look.icon}"`);
    }
    if (unknown.size) report(theme, `unknown Lucide icon names (use lucide.dev names like "snowflake", "sun", "moon", or svg): ${[...unknown].join(', ')}`);
  }, [theme]);
};

const ThemeControls: React.FC<{ theme: UiTheme }> = ({ theme }) => {
  const controls = useMemo(() => theme.controls ?? [], [theme.controls]);
  const values = useThemeValues(theme.id);
  const [floatLayer, setFloatLayer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const layer = document.createElement('div');
    layer.className = 'theme-controls-float';
    document.body.appendChild(layer);
    setFloatLayer(layer);
    return () => layer.remove();
  }, []);
  const placed = usePlacements(theme, controls, floatLayer);
  useIconReports(theme);
  const byId = useMemo(() => new Map(controls.map((control) => [control.id, control])), [controls]);
  return (
    <>
      {placed.map((entry) => {
        const control = byId.get(entry.id);
        return control ? createPortal(<ControlView theme={theme} control={control} values={values} />, entry.host, entry.key) : null;
      })}
    </>
  );
};

export default ThemeControls;
