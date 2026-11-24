import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud, Loader2 } from 'lucide-react';
import {
  botModelEfforts,
  botModelLabel,
  botReasoningEffortLabel,
  botReasoningEffortShortLabel,
  defaultBotReasoningEffort,
  effectiveBotReasoningEffort,
  type BotModelChoice,
} from './bots';

/**
 * A bot's reply model and reasoning effort, in the bot's header (Bots view).
 * Picking either only changes the setting: a reply already running finishes on
 * what it began on, and the next one runs on the new setting with the same
 * memory and messages. Prompt caches are per model, so switching models starts
 * the cache over once. Models that aren't Claude reply from Durango's cloud.
 */
export const BotModelMenu = ({
  model,
  reasoningEffort,
  choices,
  local,
  onPick,
}: {
  model: string;
  reasoningEffort?: string | null;
  choices: readonly BotModelChoice[];
  /** A bot on this computer only (signed out): every reply runs here. */
  local: boolean;
  /** → an error to show, or null when it was saved. */
  onPick: (update: { model?: string; reasoningEffort?: string | null }) => Promise<string | null>;
}) => {
  const [open, setOpen] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const efforts = botModelEfforts(model, choices);
  const effectiveEffort = effectiveBotReasoningEffort(model, reasoningEffort, choices);
  const defaultEffort = defaultBotReasoningEffort(model, choices);
  const effortLabel = botReasoningEffortLabel(effectiveEffort);

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
        <span className="max-w-[140px] truncate">{botModelLabel(model, choices)}</span>
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
          role="listbox"
          aria-label="Reply model and reasoning"
          className="absolute right-0 top-[calc(100%+6px)] z-[100] w-[292px] overflow-hidden rounded-lg border border-[#3a3a40] bg-[#1f1f21] shadow-2xl"
        >
          <div className="max-h-[280px] overflow-y-auto py-1">
            {choices.map((choice) => {
              const selected = choice.id === model;
              return (
                <button
                  key={choice.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={savingKey !== null}
                  onClick={() => void pickModel(choice.id)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[#2f2f31] disabled:cursor-default ${
                    selected ? 'text-white' : 'text-[#c0c0c0]'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px]">{choice.label}</span>
                    <span className="flex items-center gap-1 truncate text-[11px] text-neutral-500">
                      {!local && !choice.claude ? (
                        <>
                          <Cloud size={10} className="shrink-0" /> Replies from Durango’s cloud
                        </>
                      ) : (
                        choice.note
                      )}
                    </span>
                  </span>
                  {savingKey === `model:${choice.id}` ? (
                    <Loader2 size={13} className="shrink-0 animate-spin" />
                  ) : selected ? (
                    <Check size={13} className="shrink-0" />
                  ) : null}
                </button>
              );
            })}
          </div>
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
