import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown, Cloud, Laptop, Loader2, Search, X } from 'lucide-react';
import {
  botModelEfforts,
  botModelLabel,
  botReasoningEffortLabel,
  botReasoningEffortShortLabel,
  defaultBotReasoningEffort,
  effectiveBotReasoningEffort,
  type BotModelChoice,
} from './bots';

export type BotModelPickerTab = 'recommended' | 'all' | 'local' | 'cloud';

/** Whether a model runs locally on this machine (via Claude Code) rather than Durango's cloud. */
export const isLocalBotModelChoice = (choice: BotModelChoice, localMode: boolean): boolean =>
  localMode || (typeof choice.local === 'boolean' ? choice.local : choice.claude);

const searchTokens = (query: string): string[] =>
  query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

const matchesTokens = (choice: BotModelChoice, tokens: readonly string[]): boolean => {
  if (tokens.length === 0) return true;
  const haystack = `${choice.label} ${choice.provider ?? ''} ${choice.lab ?? ''} ${choice.id} ${choice.note}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
};

const matchRank = (choice: BotModelChoice, normalizedQuery: string): number => {
  const label = choice.label.toLowerCase();
  const id = choice.id.toLowerCase();
  const provider = (choice.provider ?? '').toLowerCase();
  if (label === normalizedQuery || id === normalizedQuery) return 0;
  if (label.startsWith(normalizedQuery)) return 1;
  if (label.includes(normalizedQuery)) return 2;
  if (provider.startsWith(normalizedQuery)) return 3;
  if (id.includes(normalizedQuery)) return 4;
  return 5;
};

export type FilteredBotModels = {
  items: BotModelChoice[];
  hiddenLegacyCount: number;
  /** Matches in the opposite source tab when searching Local or Cloud returns 0 hits. */
  alternateTab: BotModelPickerTab | null;
  alternateMatchesCount: number;
};

/**
 * Pure filter + search pipeline for the bot reply-model picker.
 * - Searching from Recommended widens to All so any provider/model is one keystroke away.
 * - Searching Local or Cloud stays scoped to that source and surfaces a shortcut if matches live in the other tab.
 * - Without a search query, All/Cloud keep current models crisp and fold legacy models behind a toggle
 *   (always keeping the currently selected model visible).
 */
export const filterBotModelChoices = ({
  allChoices,
  recommendedChoices,
  selectedModelId,
  tab,
  query,
  localMode,
  showLegacy,
}: {
  allChoices: readonly BotModelChoice[];
  recommendedChoices: readonly BotModelChoice[];
  selectedModelId: string;
  tab: BotModelPickerTab;
  query: string;
  localMode: boolean;
  showLegacy: boolean;
}): FilteredBotModels => {
  const trimmed = query.trim().toLowerCase();
  const tokens = searchTokens(query);

  if (tokens.length > 0) {
    const scope =
      tab === 'local'
        ? allChoices.filter((choice) => isLocalBotModelChoice(choice, localMode))
        : tab === 'cloud'
          ? allChoices.filter((choice) => !isLocalBotModelChoice(choice, localMode))
          : allChoices;

    const matched = scope
      .map((choice, index) => ({ choice, index }))
      .filter(({ choice }) => matchesTokens(choice, tokens))
      .sort((a, b) => {
        const rankDiff = matchRank(a.choice, trimmed) - matchRank(b.choice, trimmed);
        if (rankDiff !== 0) return rankDiff;
        const legacyDiff = Number(Boolean(a.choice.legacy)) - Number(Boolean(b.choice.legacy));
        if (legacyDiff !== 0) return legacyDiff;
        const recDiff = Number(Boolean(b.choice.recommended)) - Number(Boolean(a.choice.recommended));
        if (recDiff !== 0) return recDiff;
        return a.index - b.index;
      })
      .map(({ choice }) => choice);

    let alternateTab: BotModelPickerTab | null = null;
    let alternateMatchesCount = 0;
    if (matched.length === 0 && !localMode && (tab === 'local' || tab === 'cloud')) {
      const otherTab: BotModelPickerTab = tab === 'local' ? 'cloud' : 'local';
      const otherScope =
        otherTab === 'local'
          ? allChoices.filter((choice) => isLocalBotModelChoice(choice, localMode))
          : allChoices.filter((choice) => !isLocalBotModelChoice(choice, localMode));
      alternateMatchesCount = otherScope.filter((choice) => matchesTokens(choice, tokens)).length;
      if (alternateMatchesCount > 0) alternateTab = otherTab;
    }

    return { items: matched, hiddenLegacyCount: 0, alternateTab, alternateMatchesCount };
  }

  if (tab === 'recommended') {
    return {
      items: [...recommendedChoices],
      hiddenLegacyCount: 0,
      alternateTab: null,
      alternateMatchesCount: 0,
    };
  }

  const scoped =
    tab === 'local'
      ? allChoices.filter((choice) => isLocalBotModelChoice(choice, localMode))
      : tab === 'cloud'
        ? allChoices.filter((choice) => !isLocalBotModelChoice(choice, localMode))
        : [...allChoices];

  if (showLegacy || tab === 'local') {
    return { items: scoped, hiddenLegacyCount: 0, alternateTab: null, alternateMatchesCount: 0 };
  }

  const visible: BotModelChoice[] = [];
  let hiddenLegacyCount = 0;
  for (const choice of scoped) {
    if (choice.legacy && choice.id !== selectedModelId) {
      hiddenLegacyCount += 1;
    } else {
      visible.push(choice);
    }
  }
  return { items: visible, hiddenLegacyCount, alternateTab: null, alternateMatchesCount: 0 };
};

const providerLabelOf = (choice: BotModelChoice): string => {
  if (choice.provider) return choice.provider;
  if (choice.claude) return 'Anthropic';
  const ns = choice.id.split('/')[0];
  return ns ? ns.charAt(0).toUpperCase() + ns.slice(1) : '';
};

/**
 * A bot's reply model and reasoning effort, in the bot's header (Bots view).
 * Picking either only changes the setting: a reply already running finishes on
 * what it began on, and the next one runs on the new setting with the same
 * memory and messages. Prompt caches are per model, so switching models starts
 * the cache over once. Claude models can reply locally via Claude Code; models
 * from other providers reply from Durango's cloud.
 */
export const BotModelMenu = ({
  model,
  reasoningEffort,
  choices,
  catalog,
  local,
  claudeAvailable = true,
  machineReplies = true,
  onPick,
}: {
  model: string;
  reasoningEffort?: string | null;
  choices: readonly BotModelChoice[];
  /** Full searchable catalog (recommended + cloud catalog + machine Claude models). */
  catalog?: readonly BotModelChoice[] | null;
  /** A bot on this computer only (signed out): every reply runs here. */
  local: boolean;
  /** Whether Claude Code is available on this machine to run local Claude replies. */
  claudeAvailable?: boolean;
  /** Whether Settings → Durango "Answer your bots on this computer" is enabled. */
  machineReplies?: boolean;
  /** → an error to show, or null when it was saved. */
  onPick: (update: { model?: string; reasoningEffort?: string | null }) => Promise<string | null>;
}) => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<BotModelPickerTab>('recommended');
  const [query, setQuery] = useState('');
  const [showLegacy, setShowLegacy] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Merge catalog + choices once so every lookup (labels, efforts, tabs, search) shares one canonical list.
  const allChoices = useMemo<BotModelChoice[]>(() => {
    const source = catalog && catalog.length > 0 ? catalog : choices;
    const seen = new Set<string>();
    const out: BotModelChoice[] = [];
    for (const item of source) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    for (const item of choices) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }, [catalog, choices]);

  const recommendedChoices = useMemo<BotModelChoice[]>(() => {
    const rec = allChoices.filter((choice) => choice.recommended);
    return rec.length > 0 ? rec : [...choices];
  }, [allChoices, choices]);

  const counts = useMemo(() => {
    let localCount = 0;
    let cloudCount = 0;
    for (const choice of allChoices) {
      if (isLocalBotModelChoice(choice, local)) localCount += 1;
      else cloudCount += 1;
    }
    return {
      recommended: recommendedChoices.length,
      all: allChoices.length,
      local: localCount,
      cloud: cloudCount,
    };
  }, [allChoices, recommendedChoices, local]);

  const filtered = useMemo(
    () =>
      filterBotModelChoices({
        allChoices,
        recommendedChoices,
        selectedModelId: model,
        tab,
        query,
        localMode: local,
        showLegacy,
      }),
    [allChoices, recommendedChoices, model, tab, query, local, showLegacy]
  );

  // Reset search/tab/focus cleanly whenever the menu opens.
  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setShowLegacy(false);
    setTab('recommended');
    const selectedIdx = recommendedChoices.findIndex((item) => item.id === model);
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    const onPointerDown = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, model, recommendedChoices]);

  // Keep activeIndex in bounds whenever the filtered list changes.
  useEffect(() => {
    if (!open) return;
    if (filtered.items.length === 0) {
      setActiveIndex(0);
      return;
    }
    if (query.trim()) {
      setActiveIndex(0);
      if (listRef.current) listRef.current.scrollTop = 0;
      return;
    }
    const selectedIdx = filtered.items.findIndex((item) => item.id === model);
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
  }, [open, tab, query, filtered.items, model]);

  // Scroll the highlighted row into view within the list container (never scrolls the window).
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const row = optionRefs.current[activeIndex];
    if (!list || !row) return;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowTop < list.scrollTop) {
      list.scrollTop = rowTop;
    } else if (rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowBottom - list.clientHeight;
    }
  }, [open, activeIndex]);

  const efforts = botModelEfforts(model, allChoices);
  const effectiveEffort = effectiveBotReasoningEffort(model, reasoningEffort, allChoices);
  const defaultEffort = defaultBotReasoningEffort(model, allChoices);
  const effortLabel = botReasoningEffortLabel(effectiveEffort);
  const localMachineActive = local || (claudeAvailable && machineReplies);

  const pickModel = async (id: string) => {
    if (savingKey) return;
    if (id === model) {
      setOpen(false);
      return;
    }
    setSavingKey(`model:${id}`);
    setError(null);
    const failure = await onPick({ model: id }).catch(() => 'Couldn’t change the model. Try again.');
    setSavingKey(null);
    if (failure) setError(failure);
    else setOpen(false);
  };

  const pickEffort = async (effort: string) => {
    if (savingKey) return;
    if (effort === effectiveEffort && reasoningEffort === effort) {
      setOpen(false);
      return;
    }
    setSavingKey(`effort:${effort}`);
    setError(null);
    const failure = await onPick({ reasoningEffort: effort }).catch(() => 'Couldn’t change reasoning. Try again.');
    setSavingKey(null);
    if (failure) setError(failure);
    else setOpen(false);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const count = filtered.items.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (count > 0) setActiveIndex((current) => (current + 1) % count);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (count > 0) setActiveIndex((current) => (current - 1 + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = filtered.items[activeIndex];
      if (target) void pickModel(target.id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const tabs: Array<{ id: BotModelPickerTab; label: string; count: number }> = local
    ? [
        { id: 'recommended', label: 'Recommended', count: counts.recommended },
        { id: 'all', label: 'All', count: counts.all },
      ]
    : [
        { id: 'recommended', label: 'Recommended', count: counts.recommended },
        { id: 'all', label: 'All', count: counts.all },
        { id: 'local', label: 'Local', count: counts.local },
        { id: 'cloud', label: 'Cloud', count: counts.cloud },
      ];

  const isSearchingFromRecommended = Boolean(query.trim()) && tab === 'recommended';
  const showGroupHeaders = !query.trim() && (tab === 'all' || tab === 'cloud');
  const groupLabelOf = (choice: BotModelChoice): string => (choice.recommended ? 'Recommended' : providerLabelOf(choice));

  return (
    <div className="relative shrink-0 [-webkit-app-region:no-drag]" ref={anchorRef}>
      <button
        type="button"
        title="The model and reasoning level this bot replies to you with"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setError(null);
          setOpen((current) => !current);
        }}
        className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-[var(--text-secondary)] transition-colors duration-75 hover:bg-white/[0.06] hover:text-[var(--text-primary)]"
      >
        <span className="max-w-[160px] truncate">{botModelLabel(model, allChoices)}</span>
        {effortLabel && (
          <>
            <span className="opacity-40">·</span>
            <span className="shrink-0 opacity-75">{effortLabel}</span>
          </>
        )}
        <ChevronDown size={12} className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Reply model and reasoning"
          className="absolute right-0 top-[calc(100%+6px)] z-[100] w-[356px] overflow-hidden rounded-xl border border-[#3a3a40] bg-[#1c1c1f] shadow-2xl"
        >
          {/* Search input */}
          <div className="border-b border-white/[0.06] px-2.5 py-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 focus-within:border-white/[0.2]">
              <Search size={13} className="shrink-0 text-neutral-500" />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={local ? 'Search local Claude models…' : 'Search all models & providers…'}
                aria-label="Search bot models"
                aria-controls="bot-model-listbox"
                aria-activedescendant={filtered.items[activeIndex] ? `bot-model-opt-${activeIndex}` : undefined}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-white placeholder-neutral-500 outline-none"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery('');
                    searchInputRef.current?.focus();
                  }}
                  className="rounded p-0.5 text-neutral-500 hover:bg-white/[0.08] hover:text-neutral-200"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Tabs */}
            <div
              role="tablist"
              aria-label="Filter reply models"
              className="mt-2 flex items-center gap-0.5 rounded-lg bg-white/[0.04] p-0.5"
            >
              {tabs.map((item) => {
                const active = isSearchingFromRecommended ? item.id === 'all' : tab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setTab(item.id);
                      setShowLegacy(false);
                      searchInputRef.current?.focus();
                    }}
                    className={`flex h-6 items-center justify-center gap-1 rounded-md px-2 text-[11px] transition-colors ${
                      item.id === 'recommended' ? 'shrink-0' : 'flex-1'
                    } ${
                      active
                        ? 'bg-white/[0.13] font-medium text-white shadow-sm'
                        : 'text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200'
                    }`}
                  >
                    {item.id === 'local' && <Laptop size={10} className="shrink-0 opacity-80" />}
                    {item.id === 'cloud' && <Cloud size={10} className="shrink-0 opacity-80" />}
                    <span className="truncate">{item.label}</span>
                    <span className={`text-[10px] ${active ? 'text-neutral-300' : 'text-neutral-500'}`}>{item.count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Truthful source context strip on Local / Cloud tabs */}
          {!local && tab === 'local' && (
            <div className="flex items-start gap-1.5 border-b border-white/[0.06] bg-emerald-500/[0.06] px-3 py-1.5 text-[11px] leading-snug text-neutral-400">
              <Laptop size={11} className="mt-0.5 shrink-0 text-emerald-400/90" />
              <span>
                {localMachineActive
                  ? 'Runs locally on this machine via Claude Code (falls back to cloud if offline). Only Claude models run locally.'
                  : !claudeAvailable
                    ? 'Claude Code isn’t available on this machine — these will reply from Durango’s cloud until Claude Code is installed.'
                    : 'Machine replies are off in Settings → Durango — these will reply from Durango’s cloud until turned on.'}
              </span>
            </div>
          )}
          {!local && tab === 'cloud' && (
            <div className="flex items-start gap-1.5 border-b border-white/[0.06] bg-sky-500/[0.06] px-3 py-1.5 text-[11px] leading-snug text-neutral-400">
              <Cloud size={11} className="mt-0.5 shrink-0 text-sky-400/90" />
              <span>Replies from Durango’s cloud. OpenAI, Google, and other non-Claude models always route to the cloud.</span>
            </div>
          )}

          {/* Model list */}
          <div
            ref={listRef}
            id="bot-model-listbox"
            role="listbox"
            aria-label="Reply models"
            className="relative max-h-[352px] overflow-y-auto py-1"
          >
            {filtered.items.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-neutral-500">
                <div>No models matching &ldquo;{query.trim()}&rdquo;</div>
                {filtered.alternateTab && filtered.alternateMatchesCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setTab(filtered.alternateTab!);
                      searchInputRef.current?.focus();
                    }}
                    className="mt-2 inline-flex items-center gap-1 rounded-md border border-white/[0.1] bg-white/[0.05] px-2.5 py-1 text-[11.5px] text-neutral-200 transition-colors hover:bg-white/[0.1]"
                  >
                    Show {filtered.alternateMatchesCount} in {filtered.alternateTab === 'cloud' ? 'Cloud' : 'Local'}
                  </button>
                )}
              </div>
            ) : (
              filtered.items.map((choice, index) => {
                const selected = choice.id === model;
                const highlighted = index === activeIndex;
                const isLocalChoice = isLocalBotModelChoice(choice, local);
                const provider = providerLabelOf(choice);
                const groupLabel = groupLabelOf(choice);
                const prevGroupLabel = index > 0 ? groupLabelOf(filtered.items[index - 1]) : null;
                const showHeader = showGroupHeaders && groupLabel && groupLabel !== prevGroupLabel;
                const subtitle =
                  tab === 'recommended' && !query.trim()
                    ? choice.note || provider
                    : choice.note && choice.note.toLowerCase() !== provider.toLowerCase()
                      ? `${provider} · ${choice.note}`
                      : provider || choice.id;

                return (
                  <div key={choice.id}>
                    {showHeader && (
                      <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                        {groupLabel}
                      </div>
                    )}
                    <button
                      ref={(node) => {
                        optionRefs.current[index] = node;
                      }}
                      id={`bot-model-opt-${index}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={savingKey !== null}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => void pickModel(choice.id)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:cursor-default ${
                        highlighted ? 'bg-white/[0.09]' : 'hover:bg-white/[0.06]'
                      } ${selected ? 'text-white' : 'text-[#d0d0d4]'}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12.5px] font-medium">{choice.label}</span>
                          {choice.legacy && (
                            <span className="shrink-0 rounded bg-white/[0.06] px-1 py-0.2 text-[9.5px] text-neutral-500">
                              Legacy
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[11px] text-neutral-500">{subtitle}</span>
                      </span>
                      {!local && (
                        <span
                          title={
                            isLocalChoice
                              ? localMachineActive
                                ? 'Replies locally on this machine via Claude Code (cloud fallback)'
                                : 'Can reply locally via Claude Code; currently routes to Durango’s cloud'
                              : 'Replies from Durango’s cloud'
                          }
                          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                            isLocalChoice
                              ? localMachineActive
                                ? 'bg-emerald-500/12 text-emerald-300/90 ring-1 ring-emerald-500/20'
                                : 'bg-white/[0.06] text-neutral-400 ring-1 ring-white/[0.08]'
                              : 'bg-sky-500/10 text-sky-300/85 ring-1 ring-sky-500/20'
                          }`}
                        >
                          {isLocalChoice ? <Laptop size={9} /> : <Cloud size={9} />}
                          {isLocalChoice ? 'Local' : 'Cloud'}
                        </span>
                      )}
                      {savingKey === `model:${choice.id}` ? (
                        <Loader2 size={13} className="shrink-0 animate-spin text-neutral-300" />
                      ) : selected ? (
                        <Check size={13} className="shrink-0 text-white" />
                      ) : null}
                    </button>
                  </div>
                );
              })
            )}
            {filtered.hiddenLegacyCount > 0 && (
              <div className="px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => setShowLegacy(true)}
                  className="w-full rounded-md border border-white/[0.07] bg-white/[0.03] px-2.5 py-1 text-[11px] text-neutral-400 transition-colors hover:bg-white/[0.07] hover:text-neutral-200"
                >
                  Show {filtered.hiddenLegacyCount} legacy models
                </button>
              </div>
            )}
          </div>

          {/* Reasoning effort section */}
          {efforts.length > 0 && (
            <div className="border-t border-white/[0.06] px-3 py-2.5">
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="font-medium text-neutral-400">Reasoning</span>
                <span className="text-neutral-500">
                  {effortLabel}
                  {effectiveEffort === defaultEffort ? ' (default)' : ''}
                </span>
              </div>
              <div className="flex items-center gap-1 rounded-md bg-white/[0.04] p-0.5" role="radiogroup" aria-label="Reasoning effort">
                {efforts.map((effort) => {
                  const active = effort === effectiveEffort;
                  const full = botReasoningEffortLabel(effort);
                  const short = botReasoningEffortShortLabel(effort);
                  return (
                    <button
                      key={effort}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      title={effort === defaultEffort ? `${full} (default)` : full}
                      disabled={savingKey !== null}
                      onClick={() => void pickEffort(effort)}
                      className={`flex h-6 flex-1 items-center justify-center rounded px-1 text-[11px] transition-colors disabled:cursor-default ${
                        active
                          ? 'bg-white/[0.14] font-medium text-white shadow-sm'
                          : 'text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-200'
                      }`}
                    >
                      {savingKey === `effort:${effort}` ? <Loader2 size={11} className="animate-spin" /> : short}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Footer note */}
          <div className="border-t border-white/[0.06] px-3 py-2 text-[11px] leading-snug text-neutral-500">
            {error ? (
              <span className="text-red-400">{error}</span>
            ) : (
              'From the next reply; one running now finishes on its model. Memory and messages carry over. The first reply after a switch reads the conversation without the prompt cache.'
            )}
          </div>
        </div>
      )}
    </div>
  );
};
