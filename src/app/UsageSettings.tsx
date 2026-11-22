import React from 'react';
import { Check, ChevronDown, Info, RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useOrionStore } from '../store';
import { AntigravityBrandIcon, ClaudeBrandIcon, CodexBrandIcon, GrokBrandIcon } from '../providerIcons';
import type { LiveProviderLimits, LiveUsageLimits, UsageRange, UsageReport, UsageScanProgress, UsageSourceFilter } from '../types';

// Settings → Usage: how much the coding agents are used on this machine, read
// from their own session logs (src/main/usage-stats.js). Token counts are what
// the agents logged; every dollar figure is an API-price estimate.

type UsageView = 'cost' | 'tokens' | 'limits';

const PROVIDERS: Record<string, { label: string; Icon: typeof ClaudeBrandIcon; color: string }> = {
  claude: { label: 'Claude Code', Icon: ClaudeBrandIcon, color: 'var(--usage-claude)' },
  codex: { label: 'Codex', Icon: CodexBrandIcon, color: 'var(--usage-codex)' },
  grok: { label: 'Grok Build', Icon: GrokBrandIcon, color: 'var(--usage-grok)' },
};
const PROVIDER_ORDER = ['claude', 'codex', 'grok'];

const RANGES: Array<{ id: UsageRange; label: string }> = [
  { id: '24h', label: 'Past 24h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
];

const SOURCES: Array<{ value: UsageSourceFilter; label: string; hint: string }> = [
  { value: 'all', label: 'All sources', hint: 'Every session these agents logged on this Mac' },
  { value: 'durango', label: 'Durango Code', hint: 'Threads, subagents and bots' },
  { value: 'thread', label: 'Threads', hint: 'Sessions behind your Durango Code threads' },
  { value: 'subagent', label: 'Subagents', hint: 'Agents a thread spawned, e.g. a gpt-6.2-sol review' },
  { value: 'bot', label: 'Bots', hint: "Durango bots' own replies" },
  { value: 'other', label: 'Not linked to a thread', hint: 'Terminal and other apps, helper turns, deleted threads' },
];

const SOURCE_LABELS: Record<string, string> = {
  thread: 'Threads',
  subagent: 'Subagents',
  bot: 'Bots',
  other: 'Not linked to a thread',
};

const SOURCE_HINTS: Record<string, string> = {
  thread: 'Sessions behind your Durango Code threads',
  subagent: 'Agents threads spawned, plus Claude Code subagents inside them',
  bot: "Durango bots' own replies",
  other: 'Terminal and other apps, title and commit-message helpers, deleted or forked-away threads',
};

const currency = (value: number) => {
  if (!Number.isFinite(value)) return '$0.00';
  if (value > 0 && value < 0.01) return '<$0.01';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const compactCurrency = (value: number) => {
  if (value >= 1000) return `$${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  if (value >= 10) return `$${Math.round(value)}`;
  if (value === 0) return '$0';
  return `$${value.toFixed(2)}`;
};

export const formatUsageTokens = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(scaled >= 10 ? 1 : 2).replace(/\.?0+$/, '')}${unit}`;
    }
  }
  return String(Math.round(value));
};

const percent = (share: number) => {
  if (share <= 0) return '0%';
  if (share < 0.001) return '<0.1%';
  return `${(share * 100).toFixed(1)}%`;
};

// --- dropdown -----------------------------------------------------------------

type MenuOption = { value: string; label: string; hint?: string; icon?: React.ReactNode };

const UsageMenu = ({ label, value, options, onChange }: { label: string; value: string; options: MenuOption[]; onChange: (value: string) => void }) => {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  React.useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
      >
        {selected.icon}
        <span>{selected.label}</span>
        <ChevronDown size={13} className={`opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-[calc(100%+6px)] z-[100] min-w-[15rem] overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] py-1 shadow-[var(--shadow-md)]"
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] ${
                  active ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
                }`}
              >
                <span className="mt-[2px] flex w-4 shrink-0 justify-center">{option.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px]">{option.label}</span>
                  {option.hint && <span className="block text-[11px] text-[var(--text-muted)]">{option.hint}</span>}
                </span>
                {active && <Check size={13} className="mt-[2px] shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const Segmented = <T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void; label: string }) => (
  <div className="usage-segmented" role="tablist" aria-label={label}>
    {options.map((option) => (
      <button key={option.id} type="button" role="tab" aria-selected={value === option.id} className={value === option.id ? 'active' : ''} onClick={() => onChange(option.id)}>
        {option.label}
      </button>
    ))}
  </div>
);

const InfoTip = ({ children, align = 'start' }: { children: React.ReactNode; align?: 'start' | 'end' }) => (
  <span className={`usage-infotip ${align === 'end' ? 'align-end' : ''}`} tabIndex={0}>
    <Info size={13} aria-hidden />
    <span className="usage-infotip-body" role="tooltip">
      {children}
    </span>
  </span>
);

// --- chart --------------------------------------------------------------------

const niceMax = (value: number) => {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * base;
};

const smoothPath = (points: Array<[number, number]>) => {
  // Monotone cubic (Fritsch–Carlson) so the curve never overshoots below zero.
  if (points.length < 2) return points.length ? `M${points[0][0]},${points[0][1]}` : '';
  const n = points.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push((points[i + 1][1] - points[i][1]) / (dx[i] || 1));
  }
  const tangent: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) tangent.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  tangent.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangent[i] = t * a * slope[i];
      tangent[i + 1] = t * b * slope[i];
    }
  }
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const step = dx[i] / 3;
    d += `C${x0 + step},${y0 + tangent[i] * step} ${x1 - step},${y1 - tangent[i + 1] * step} ${x1},${y1}`;
  }
  return d;
};

const bucketLabel = (start: number, bucket: 'hour' | 'day', long = false) => {
  const date = new Date(start);
  if (bucket === 'hour') return date.toLocaleTimeString(undefined, { hour: 'numeric', ...(long ? { minute: '2-digit', weekday: 'short' } : {}) });
  return date.toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
};

const UsageChart = ({ report, view }: { report: UsageReport; view: 'cost' | 'tokens' }) => {
  const width = 640;
  const height = 230;
  const pad = { left: 52, right: 8, top: 10, bottom: 26 };
  const [hover, setHover] = React.useState<number | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const providers = PROVIDER_ORDER.filter((id) => report.providers.some((row) => row.id === id && (view === 'cost' ? row.cost > 0 : row.totalTokens > 0)));
  const values = report.series.map((bucket) => (view === 'cost' ? bucket.cost : bucket.tokens));
  const totals = values.map((row) => providers.reduce((sum, id) => sum + (row[id] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const n = report.series.length;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (index: number) => pad.left + (n <= 1 ? innerW / 2 : (index / (n - 1)) * innerW);
  const y = (value: number) => pad.top + innerH - (value / max) * innerH;
  const format = view === 'cost' ? compactCurrency : formatUsageTokens;

  // Stacked areas, Claude at the bottom.
  const layers: Array<{ id: string; area: string; line: string }> = [];
  const base = new Array(n).fill(0);
  for (const id of providers) {
    const top = values.map((row, index) => base[index] + (row[id] ?? 0));
    const upper = top.map((value, index) => [x(index), y(value)] as [number, number]);
    const lower = base.map((value, index) => [x(index), y(value)] as [number, number]).reverse();
    const line = smoothPath(upper);
    const lowerPath = smoothPath(lower).replace(/^M/, 'L');
    layers.push({ id, line, area: `${line}${lowerPath}Z` });
    top.forEach((value, index) => {
      base[index] = value;
    });
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * max);
  const labelEvery = Math.max(1, Math.ceil(n / 7));
  const xLabels = report.series
    .map((bucket, index) => ({ index, start: bucket.start }))
    .filter(({ index }) => index === 0 || index === n - 1 || (index % labelEvery === 0 && n - 1 - index >= labelEvery / 2));

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const relative = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.round(((relative - pad.left) / innerW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, index)));
  };

  const hovered = hover !== null ? report.series[hover] : null;
  const hoverValues = hover !== null ? values[hover] : null;
  return (
    <div className="usage-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${view === 'cost' ? 'Cost' : 'Tokens'} per ${report.window.bucket}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="usage-chart-grid" />
            <text x={pad.left - 8} y={y(tick)} className="usage-chart-axis" textAnchor="end" dominantBaseline="middle">
              {format(tick)}
            </text>
          </g>
        ))}
        {layers.map((layer) => (
          <path key={`${layer.id}-area`} d={layer.area} fill={PROVIDERS[layer.id]?.color} className="usage-chart-area" />
        ))}
        {layers.map((layer) => (
          <path key={`${layer.id}-line`} d={layer.line} stroke={PROVIDERS[layer.id]?.color} className="usage-chart-line" />
        ))}
        {xLabels.map(({ index, start }) => (
          <text
            key={start}
            x={x(index)}
            y={height - 6}
            className="usage-chart-axis"
            textAnchor={index === 0 ? 'start' : index === n - 1 ? 'end' : 'middle'}
          >
            {bucketLabel(start, report.window.bucket).toUpperCase()}
          </text>
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} className="usage-chart-crosshair" />
            {(() => {
              let stacked = 0;
              return providers.map((id) => {
                stacked += hoverValues?.[id] ?? 0;
                return <circle key={id} cx={x(hover)} cy={y(stacked)} r={4} fill={PROVIDERS[id].color} className="usage-chart-dot" />;
              });
            })()}
          </g>
        )}
      </svg>
      {hovered && hover !== null && (
        <div className="usage-chart-tooltip" style={{ left: `${(x(hover) / width) * 100}%`, transform: `translateX(${hover > n / 2 ? 'calc(-100% - 12px)' : '12px'})` }}>
          <div className="usage-chart-tooltip-title">{bucketLabel(hovered.start, report.window.bucket, true)}</div>
          {providers.map((id) => (
            <div key={id} className="usage-chart-tooltip-row">
              <span className="usage-dot" style={{ background: PROVIDERS[id].color }} />
              <span>{PROVIDERS[id].label}</span>
              <span className="usage-num">{view === 'cost' ? currency(hoverValues?.[id] ?? 0) : formatUsageTokens(hoverValues?.[id] ?? 0)}</span>
            </div>
          ))}
          {providers.length > 1 && (
            <div className="usage-chart-tooltip-row total">
              <span />
              <span>Total</span>
              <span className="usage-num">{view === 'cost' ? currency(totals[hover]) : formatUsageTokens(totals[hover])}</span>
            </div>
          )}
        </div>
      )}
      {providers.length > 1 && (
        <div className="usage-legend">
          {providers.map((id) => (
            <span key={id}>
              <span className="usage-dot" style={{ background: PROVIDERS[id].color }} />
              {PROVIDERS[id].label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

// --- breakdown bars --------------------------------------------------------------

const BreakdownBar = ({ title, parts, aside }: { title: string; parts: Array<{ id: string; label: string; value: number; color: string; hint?: string }>; aside?: React.ReactNode }) => {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const visible = parts.filter((part) => part.value > 0);
  return (
    <div className="usage-breakdown">
      <div className="usage-section-head">
        <span>{title}</span>
        {aside}
      </div>
      <div className="usage-bar" role="img" aria-label={parts.map((part) => `${part.label} ${currency(part.value)}`).join(', ')}>
        {total > 0 ? (
          visible.map((part) => <span key={part.id} style={{ flexGrow: part.value, background: part.color }} title={`${part.label} ${currency(part.value)}`} />)
        ) : (
          <span style={{ flexGrow: 1, background: 'var(--bg-elevated)' }} />
        )}
      </div>
      <div className="usage-bar-legend">
        {parts.map((part) => (
          <span key={part.id} title={part.hint}>
            <span className="usage-swatch" style={{ background: part.color }} />
            {part.label}
            <span className="usage-num">{currency(part.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
};

// --- limits -----------------------------------------------------------------------

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: '5-hour session',
  seven_day: 'Weekly, all models',
  seven_day_opus: 'Weekly, Opus',
  seven_day_sonnet: 'Weekly, Sonnet',
  seven_day_overage_included: 'Weekly, incl. extra usage',
  overage: 'Extra usage',
  unknown: 'Usage limit',
};

const windowName = (minutes?: number) => {
  if (!minutes) return 'Usage window';
  if (minutes === 300) return '5-hour window';
  if (minutes === 10080) return 'Weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
};

const relativeTime = (time: number) => {
  const diff = time - Date.now();
  const abs = Math.abs(diff);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60 * 60 * 1000) return formatter.format(Math.round(diff / 60000), 'minute');
  if (abs < 48 * 60 * 60 * 1000) return formatter.format(Math.round(diff / 3_600_000), 'hour');
  return formatter.format(Math.round(diff / 86_400_000), 'day');
};

const resetLabel = (time: number | null | undefined) => {
  if (!time) return null;
  if (time <= Date.now()) return 'Reset since this report';
  return `Resets ${relativeTime(time)} · ${new Date(time).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
};

const LimitMeter = ({ name, used, detail, status }: { name: string; used: number | null; detail: string | null; status?: string | null }) => {
  const level = used === null ? 'unknown' : used >= 90 ? 'critical' : used >= 70 ? 'warning' : 'ok';
  return (
    <div className="usage-limit-row">
      <div className="usage-limit-head">
        <span>{name}</span>
        <span className="usage-num">
          {used === null ? (status === 'rejected' ? 'Limit reached' : status === 'allowed_warning' ? 'Approaching limit' : status === 'allowed' ? 'Within limit' : '—') : `${Math.round(used)}% used`}
        </span>
      </div>
      <div className={`usage-limit-track ${level}`}>
        <span style={{ width: `${Math.min(100, Math.max(used ?? 0, used === null ? 0 : 1))}%` }} />
      </div>
      {detail && <div className="usage-limit-detail">{detail}</div>}
    </div>
  );
};

// One provider's live limits (provider-usage-limits.js): its windows, or why
// there are none.
const LiveLimitsBody = ({ limits, loading, empty }: { limits: LiveProviderLimits | undefined; loading: boolean; empty: string }) => {
  if (!limits) return <p className="usage-empty-note">{loading ? 'Checking…' : empty}</p>;
  if (limits.status !== 'ok') return <p className="usage-empty-note">{limits.detail || empty}</p>;
  if (!limits.windows?.length) return <p className="usage-empty-note">{empty}</p>;
  return (
    <>
      {limits.windows.map((window) => (
        <LimitMeter
          key={window.id}
          name={window.label}
          used={window.usedPercent}
          detail={resetLabel(window.resetsAt)}
        />
      ))}
    </>
  );
};

const LimitsView = ({ report }: { report: UsageReport }) => {
  const [live, setLive] = React.useState<LiveUsageLimits | null>(null);
  const [liveLoading, setLiveLoading] = React.useState<Record<string, boolean>>({});
  // Each provider's card fills in as its own read lands: Codex may first have
  // to start its app-server, which takes several seconds.
  const loadLive = React.useCallback(async (force = false) => {
    const read = window.orion?.usageLiveLimits;
    if (!read) return;
    await Promise.all(
      ['antigravity', 'grok', 'codex'].map(async (providerId) => {
        setLiveLoading((current) => ({ ...current, [providerId]: true }));
        try {
          const result = await read({ force, providers: [providerId] });
          if (result.ok) setLive((current) => ({ ...(current ?? {}), ...result.limits }));
        } finally {
          setLiveLoading((current) => ({ ...current, [providerId]: false }));
        }
      })
    );
  }, []);
  React.useEffect(() => {
    void loadLive();
  }, [loadLive]);
  const liveCodex = live?.codex && 'value' in live.codex ? live.codex : null;
  const codex = liveCodex ?? report.limits.codex;
  const claudeEntries = Object.entries(report.limits.claude ?? {}).sort(([a], [b]) => Object.keys(CLAUDE_WINDOWS).indexOf(a) - Object.keys(CLAUDE_WINDOWS).indexOf(b));
  const claudeAt = claudeEntries.reduce((latest, [, value]) => Math.max(latest, value.at), 0);
  return (
    <div className="usage-limits">
      <section className="usage-card">
        <div className="usage-card-title">
          <ClaudeBrandIcon size={16} />
          <span>Claude Code</span>
          {claudeAt > 0 && <span className="usage-card-meta">Reported {relativeTime(claudeAt)}</span>}
        </div>
        {claudeEntries.length === 0 ? (
          <p className="usage-empty-note">
            Claude Code reports its plan limits while it runs. They show here after the next Claude Code run in Durango Code (a thread or a bot reply).
          </p>
        ) : (
          claudeEntries.map(([type, value]) => {
            const used = value.utilization === null ? null : value.utilization <= 1 ? value.utilization * 100 : value.utilization;
            return (
              <LimitMeter
                key={type}
                name={CLAUDE_WINDOWS[type] ?? type.replace(/_/g, ' ')}
                used={used}
                status={value.status}
                detail={[resetLabel(value.resetsAt), value.usingOverage ? 'Using extra usage' : null].filter(Boolean).join(' · ') || null}
              />
            );
          })
        )}
        <p className="usage-card-foot">From the plan usage Claude Code reports with each request in Durango Code (threads and bot replies), so it is as current as the last Claude run.</p>
      </section>

      <section className="usage-card">
        <div className="usage-card-title">
          <CodexBrandIcon size={16} />
          <span>Codex</span>
          {codex?.value?.plan_type && <span className="usage-pill">{codex.value.plan_type}</span>}
          {codex && <span className="usage-card-meta">{liveCodex ? 'Live' : 'Reported'} {relativeTime(codex.at)}</span>}
        </div>
        {!codex ? (
          <p className="usage-empty-note">No Codex session on this Mac has reported plan limits yet.</p>
        ) : (
          <>
            {[codex.value.primary, codex.value.secondary].filter(Boolean).map((limit, index) => (
              <LimitMeter
                key={index}
                name={windowName(limit?.window_minutes)}
                used={typeof limit?.used_percent === 'number' ? limit.used_percent : null}
                detail={resetLabel(typeof limit?.resets_at === 'number' ? limit.resets_at * 1000 : null)}
              />
            ))}
            {codex.value.credits && (codex.value.credits.balance || codex.value.credits.unlimited) && (
              <div className="usage-limit-row">
                <div className="usage-limit-head">
                  <span>Credits</span>
                  <span className="usage-num">
                    {codex.value.credits.unlimited ? 'Unlimited' : Number(codex.value.credits.balance).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
        <p className="usage-card-foot">
          {liveCodex
            ? 'Read live from Codex with its own sign-in.'
            : "From the latest rate-limit snapshot in Codex's session logs. It updates with each Codex turn, so it can be behind if Codex last ran a while ago."}
        </p>
      </section>

      <section className="usage-card">
        <div className="usage-card-title">
          <AntigravityBrandIcon size={16} />
          <span>Antigravity</span>
          {live?.antigravity?.plan && <span className="usage-pill">{live.antigravity.plan}</span>}
          <span className="usage-card-meta">
            {live?.antigravity?.at ? `${live.antigravity.status === 'ok' ? 'Live' : 'Checked'} ${relativeTime(live.antigravity.at)}` : ''}
          </span>
          <button type="button" className="usage-icon-button h-6 w-6" onClick={() => void loadLive(true)} disabled={liveLoading.antigravity === true} title="Check again" aria-label="Check live limits again">
            <RefreshCw size={12} className={liveLoading.antigravity === true ? 'animate-spin' : ''} />
          </button>
        </div>
        <LiveLimitsBody limits={live?.antigravity} loading={liveLoading.antigravity === true} empty="Antigravity reported no limits." />
        <p className="usage-card-foot">
          Read live from Google with Antigravity&apos;s own sign-in. Models in a group share its limit, and usage outside Durango Code counts too.
        </p>
      </section>

      <section className="usage-card">
        <div className="usage-card-title">
          <GrokBrandIcon size={16} />
          <span>Grok Build</span>
          <span className="usage-card-meta">
            {live?.grok?.at ? `${live.grok.status === 'ok' ? 'Live' : 'Checked'} ${relativeTime(live.grok.at)}` : ''}
          </span>
          <button type="button" className="usage-icon-button h-6 w-6" onClick={() => void loadLive(true)} disabled={liveLoading.grok === true} title="Check again" aria-label="Check live limits again">
            <RefreshCw size={12} className={liveLoading.grok === true ? 'animate-spin' : ''} />
          </button>
        </div>
        <LiveLimitsBody limits={live?.grok} loading={liveLoading.grok === true} empty="Grok reported no limits." />
        <p className="usage-card-foot">Read live from grok.com with Grok Build&apos;s own sign-in: the share of this period&apos;s credits used.</p>
      </section>

    </div>
  );
};

// --- page -------------------------------------------------------------------------

const UsageSettings = React.memo(function UsageSettings() {
  const threads = useOrionStore(useShallow((state) => state.threads));
  const [range, setRange] = React.useState<UsageRange>('7d');
  const [view, setView] = React.useState<UsageView>('cost');
  const [provider, setProvider] = React.useState('all');
  const [source, setSource] = React.useState<UsageSourceFilter>('all');
  const [report, setReport] = React.useState<UsageReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [progress, setProgress] = React.useState<UsageScanProgress | null>(null);
  const [showAllModels, setShowAllModels] = React.useState(false);
  const requestRef = React.useRef(0);

  // Agent session ids → Durango Code threads, so usage can be attributed.
  const links = React.useMemo(() => {
    const out: Array<{ sessionId: string; kind: 'thread' | 'subagent' }> = [];
    for (const thread of threads) {
      const kind = thread.parentThreadId ? 'subagent' : 'thread';
      for (const sessionId of Object.values(thread.agentSessionIds ?? {})) {
        if (typeof sessionId === 'string' && sessionId) out.push({ sessionId, kind });
      }
      const subagentId = thread.subagent?.id;
      if (typeof subagentId === 'string' && subagentId) out.push({ sessionId: subagentId, kind: 'subagent' });
    }
    return out;
  }, [threads]);
  const linksRef = React.useRef(links);
  linksRef.current = links;

  React.useEffect(() => window.orion?.onUsageProgress?.((next) => setProgress(next)), []);

  const load = React.useCallback(
    async (refresh = false) => {
      if (!window.orion?.usageReport) {
        setLoading(false);
        setError('This build of Durango Code cannot read agent usage. Restart the app after updating.');
        return;
      }
      const request = ++requestRef.current;
      setLoading(true);
      const result = await window.orion.usageReport({ range, provider, source, refresh, links: linksRef.current });
      if (request !== requestRef.current) return;
      setLoading(false);
      if (result.ok) {
        setReport(result.report);
        setError(null);
      } else setError(result.error);
    },
    [range, provider, source]
  );

  React.useEffect(() => {
    void load();
  }, [load]);

  const providerOptions: MenuOption[] = [
    { value: 'all', label: 'All agents', hint: 'Claude Code, Codex and Grok Build' },
    ...PROVIDER_ORDER.filter((id) => !report || report.availableProviders.includes(id)).map((id) => {
      const { Icon, label } = PROVIDERS[id];
      return { value: id, label, icon: <Icon size={14} /> };
    }),
  ];
  const sourceOptions: MenuOption[] = SOURCES.map((option) => ({ value: option.value, label: option.label, hint: option.hint }));

  const firstScan = loading && !report;
  const showCost = view === 'cost';

  return (
    <div className="usage-page">
      <div className="usage-toolbar">
        <div className="usage-crumbs">
          <span className="usage-crumb-root">Usage</span>
          <span className="usage-crumb-sep">/</span>
          <UsageMenu label="Source" value={source} options={sourceOptions} onChange={(value) => setSource(value as UsageSourceFilter)} />
          <span className="usage-crumb-sep">/</span>
          <UsageMenu label="Agent" value={provider} options={providerOptions} onChange={setProvider} />
        </div>
        <div className="usage-toolbar-right">
          <Segmented label="Time range" value={range} options={RANGES} onChange={setRange} />
          <Segmented
            label="View"
            value={view}
            options={[
              { id: 'cost', label: 'Cost' },
              { id: 'tokens', label: 'Tokens' },
              { id: 'limits', label: 'Limits' },
            ]}
            onChange={setView}
          />
          <button type="button" className="usage-icon-button" title="Rescan session logs" aria-label="Rescan session logs" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && <div className="usage-error">{error}</div>}

      {firstScan && (
        <div className="usage-scanning">
          <RefreshCw size={16} className="animate-spin" />
          <div>
            <div>Reading the agents&apos; session logs…</div>
            <div className="usage-muted">
              {progress && progress.total > 0 ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} sessions` : 'The first scan reads every log on this Mac and takes a few seconds; later ones read only what changed.'}
            </div>
          </div>
        </div>
      )}

      {report && view === 'limits' && <LimitsView report={report} />}

      {report && view !== 'limits' && (
        <div className={`usage-body ${loading ? 'is-loading' : ''}`}>
          <div className="usage-top">
            <div className="usage-summary">
              <div className="usage-hero usage-num">{showCost ? currency(report.totals.cost) : formatUsageTokens(report.totals.totalTokens)}</div>
              <div className="usage-hero-sub">
                {report.totals.sessions.toLocaleString()} sessions ·{' '}
                {showCost ? (
                  <>
                    API estimate
                    <InfoTip>
                      What these calls would cost at each provider&apos;s public API list prices (Vercel AI Gateway catalog
                      {report.prices.fetchedAt ? `, prices from ${new Date(report.prices.fetchedAt).toLocaleDateString()}` : ''}). It is not
                      your bill: Claude, ChatGPT and Grok subscriptions charge a flat price. Token counts are exact, as the agents logged
                      them. Grok Build&apos;s figures are its own estimate.
                    </InfoTip>
                  </>
                ) : (
                  <>
                    {formatUsageTokens(report.totals.tokens.output)} output
                    <InfoTip>Tokens as the agents logged them: input (cached and uncached), cache writes and output, including reasoning.</InfoTip>
                  </>
                )}
              </div>

              <div className="usage-agents">
                {report.providers.length === 0 && <div className="usage-muted">No agent usage in this range.</div>}
                {report.providers.map((row) => {
                  const meta = PROVIDERS[row.id] ?? { label: row.id, Icon: CodexBrandIcon, color: 'var(--text-muted)' };
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className={`usage-agent-row ${provider === row.id ? 'active' : ''}`}
                      onClick={() => setProvider(provider === row.id ? 'all' : row.id)}
                      title={provider === row.id ? 'Show all agents' : `Only ${meta.label}`}
                    >
                      <span className="usage-agent-line">
                        <span className="usage-dot" style={{ background: meta.color }} />
                        <meta.Icon size={15} />
                        <span className="usage-agent-name">{meta.label}</span>
                        <span className="usage-muted">{row.sessions.toLocaleString()} sessions</span>
                        <span className="usage-agent-value usage-num">{showCost ? currency(row.cost) : formatUsageTokens(row.totalTokens)}</span>
                      </span>
                      <span className="usage-agent-sub">
                        {showCost
                          ? `${percent(row.share)} of cost · ${formatUsageTokens(row.totalTokens)} tokens`
                          : `${percent(row.tokenShare)} of tokens · ${currency(row.cost)}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="usage-chart-wrap">
              <div className="usage-section-head">
                <span>
                  {report.window.bucket === 'hour' ? 'Hourly' : 'Daily'} {showCost ? 'cost' : 'tokens'}
                </span>
              </div>
              <UsageChart report={report} view={showCost ? 'cost' : 'tokens'} />
            </div>
          </div>

          <div className="usage-section">
            <div className="usage-section-head">
              <span>Totals</span>
            </div>
            <div className="usage-stats">
              <div>
                <span className="usage-stat-label">Processed tokens</span>
                <span className="usage-stat-value usage-num">{formatUsageTokens(report.totals.totalTokens)}</span>
              </div>
              <div>
                <span className="usage-stat-label">Cached input</span>
                <span className="usage-stat-value usage-num">{formatUsageTokens(report.totals.tokens.cacheRead)}</span>
              </div>
              <div>
                <span className="usage-stat-label">Uncached input</span>
                <span className="usage-stat-value usage-num">{formatUsageTokens(report.totals.tokens.input)}</span>
              </div>
              <div>
                <span className="usage-stat-label">Cache writes</span>
                <span className="usage-stat-value usage-num">{formatUsageTokens(report.totals.tokens.cacheWrite)}</span>
              </div>
              <div>
                <span className="usage-stat-label">Output</span>
                <span className="usage-stat-value usage-num">{formatUsageTokens(report.totals.tokens.output)}</span>
              </div>
              <div>
                <span className="usage-stat-label">
                  Cache savings
                  <InfoTip align="end">Estimated: what the cached input would have cost as uncached input, minus what it cost from the cache.</InfoTip>
                </span>
                <span className="usage-stat-value usage-num">{currency(report.totals.savings)}</span>
              </div>
            </div>
          </div>

          <div className="usage-breakdowns">
            <BreakdownBar
              title="Cost by type"
              parts={[
                { id: 'input', label: 'Input', value: report.costByType.input, color: 'var(--usage-type-1)' },
                { id: 'cacheRead', label: 'Cache read', value: report.costByType.cacheRead, color: 'var(--usage-type-2)' },
                { id: 'cacheWrite', label: 'Cache write', value: report.costByType.cacheWrite, color: 'var(--usage-type-3)' },
                { id: 'output', label: 'Output', value: report.costByType.output, color: 'var(--usage-type-4)' },
                ...(report.costByType.other > 0
                  ? [{ id: 'other', label: 'Other', value: report.costByType.other, color: 'var(--usage-type-other)', hint: "Grok Build's own estimate, not split by type" }]
                  : []),
              ]}
            />
            <BreakdownBar
              title="Cost by speed"
              aside={report.costBySpeed.fast > 0 ? <span className="usage-muted">Fast premium {currency(report.costBySpeed.fastPremium)}</span> : undefined}
              parts={[
                { id: 'standard', label: 'Standard', value: report.costBySpeed.standard, color: 'var(--usage-type-2)' },
                { id: 'fast', label: 'Fast', value: report.costBySpeed.fast, color: 'var(--usage-type-4)', hint: 'Claude fast mode and Codex priority processing' },
              ]}
            />
          </div>

          <div className="usage-tables">
            <div className="usage-section">
              <div className="usage-section-head">
                <span>By model</span>
              </div>
              <div className="usage-table">
                {(showAllModels ? report.models : report.models.slice(0, 8)).map((row) => {
                  const meta = PROVIDERS[row.provider];
                  return (
                    <div key={`${row.provider}:${row.model}`} className="usage-table-row">
                      <span className="usage-dot" style={{ background: meta?.color ?? 'var(--text-muted)' }} />
                      <span className="usage-table-name" title={row.model}>
                        {row.model}
                      </span>
                      <span className="usage-muted">{row.sessions.toLocaleString()} sessions</span>
                      <span className="usage-muted usage-num">{formatUsageTokens(row.totalTokens)}</span>
                      <span className="usage-num usage-table-value">{row.priced ? (showCost ? currency(row.cost) : percent(row.tokenShare)) : 'No price'}</span>
                    </div>
                  );
                })}
                {report.models.length > 8 && (
                  <button type="button" className="usage-link" onClick={() => setShowAllModels((current) => !current)}>
                    {showAllModels ? 'Show fewer' : `Show all ${report.models.length}`}
                  </button>
                )}
                {report.models.length === 0 && <div className="usage-muted">Nothing in this range.</div>}
              </div>
            </div>

            <div className="usage-section">
              <div className="usage-section-head">
                <span>By source</span>
              </div>
              <div className="usage-table">
                {report.sources.map((row) => (
                  <div key={row.id} className="usage-table-row" title={SOURCE_HINTS[row.id]}>
                    <span className="usage-table-name">{SOURCE_LABELS[row.id] ?? row.id}</span>
                    <span className="usage-muted">{row.sessions.toLocaleString()} sessions</span>
                    <span className="usage-muted usage-num">{formatUsageTokens(row.totalTokens)}</span>
                    <span className="usage-num usage-table-value">{showCost ? currency(row.cost) : percent(row.tokenShare)}</span>
                  </div>
                ))}
                {report.sources.length === 0 && <div className="usage-muted">Nothing in this range.</div>}
              </div>
            </div>
          </div>

          <p className="usage-footnote">
            Read from Claude Code, Codex and Grok Build session logs on this Mac. Kimi Code, Antigravity, OpenCode, Cursor and Muse runs aren&apos;t counted yet, and runs on
            your other machines stay on those machines.
            {report.unpricedModels.length > 0 &&
              ` No list price for ${report.unpricedModels.join(', ')}: ${formatUsageTokens(report.totals.unpricedTokens)} tokens are counted without a cost.`}
          </p>
        </div>
      )}
    </div>
  );
});

export default UsageSettings;
