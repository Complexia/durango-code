import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Globe } from 'lucide-react';
import { agentProviders, type AgentModel, type AgentProvider, type AgentProviderId } from '../agentCatalog';
import type { OrchestrationSettings, ProviderId } from '../store';
import { ModelPickerPopover } from './ModelPickerPopover';

export type InstructionScope =
  | { kind: 'global' }
  | { kind: 'provider'; providerId: ProviderId }
  | { kind: 'model'; modelId: string };

export type InstructionsSettingProps = {
  settings: OrchestrationSettings;
  /** Every model instructions can target, grouped by provider (includes the Claude Code CLI). */
  modelGroups: Array<{ provider: AgentProvider; models: AgentModel[] }>;
  onChangeGlobal: (text: string) => void;
  onChangeProvider: (providerId: ProviderId, text: string) => void;
  onChangeModel: (modelId: string, text: string) => void;
};

type ScopeChip = {
  key: string;
  scope: InstructionScope;
  label: string;
  icon?: AgentProvider['icon'];
};

const scopeEquals = (a: InstructionScope, b: InstructionScope) => {
  if (a.kind === 'global' || b.kind === 'global') return a.kind === b.kind;
  if (a.kind === 'provider' && b.kind === 'provider') return a.providerId === b.providerId;
  if (a.kind === 'model' && b.kind === 'model') return a.modelId === b.modelId;
  return false;
};

const hasText = (value: string | undefined) => Boolean(value && value.trim().length > 0);

const providerIdOfModelId = (modelId: string) =>
  modelId.includes(':') ? modelId.slice(0, modelId.indexOf(':')) : '';

const HAS_INSTRUCTIONS = 'Has instructions';

/**
 * Standing instructions editor. The scope picker is the shared model picker:
 * each provider tab offers "All models" (global), "All <provider>" and that
 * provider's models. Specific scopes layer on top of broader ones when a turn runs.
 */
export const InstructionsSetting: React.FC<InstructionsSettingProps> = ({
  settings,
  modelGroups,
  onChangeGlobal,
  onChangeProvider,
  onChangeModel,
}) => {
  const [scope, setScope] = useState<InstructionScope>({ kind: 'global' });
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<AgentProviderId | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const providerById = useMemo(
    () => new Map<string, AgentProvider>(agentProviders.map((provider) => [provider.id, provider])),
    []
  );

  // Models with saved instructions that the live catalog no longer lists stay
  // pickable under their provider, so they can still be read or cleared.
  const models = useMemo(() => {
    const listed = modelGroups.flatMap((group) => group.models);
    const known = new Set(listed.map((model) => model.id));
    const saved: AgentModel[] = Object.entries(settings.modelInstructions ?? {})
      .filter(([id, text]) => !known.has(id) && hasText(text) && providerById.has(providerIdOfModelId(id)))
      .map(([id]) => {
        const providerId = providerIdOfModelId(id) as AgentProviderId;
        const slug = id.slice(providerId.length + 1);
        return {
          id,
          providerId,
          providerLabel: `${providerById.get(providerId)?.label ?? providerId} · no longer listed`,
          label: slug,
          slug,
        };
      });
    return [...listed, ...saved];
  }, [modelGroups, providerById, settings.modelInstructions]);

  const modelById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);

  const providers = useMemo(() => {
    const withRows = new Set<string>(models.map((model) => model.providerId));
    for (const [id, text] of Object.entries(settings.providerInstructions ?? {})) {
      if (hasText(text)) withRows.add(id);
    }
    return agentProviders.filter((provider) => provider.id !== 'orion' && withRows.has(provider.id));
  }, [models, settings.providerInstructions]);

  const markedModelIds = useMemo(
    () =>
      new Set(
        Object.entries(settings.modelInstructions ?? {})
          .filter(([, text]) => hasText(text))
          .map(([id]) => id)
      ),
    [settings.modelInstructions]
  );
  const markedProviderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, text] of Object.entries(settings.providerInstructions ?? {})) {
      if (hasText(text)) ids.add(id);
    }
    for (const id of markedModelIds) ids.add(providerIdOfModelId(id));
    return ids;
  }, [markedModelIds, settings.providerInstructions]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const scopeProviderId =
    scope.kind === 'provider'
      ? scope.providerId
      : scope.kind === 'model'
        ? (modelById.get(scope.modelId)?.providerId ?? providerIdOfModelId(scope.modelId))
        : null;

  const toggleOpen = () => {
    if (!open) {
      setSearch('');
      // Open on the active scope's provider, else the first tab.
      const preferred = providers.find((provider) => provider.id === scopeProviderId) ?? providers[0];
      setTab(preferred?.id ?? null);
    }
    setOpen(!open);
  };

  const selectScope = (nextScope: InstructionScope) => {
    setScope(nextScope);
    setOpen(false);
  };

  const scopeLabel = (target: InstructionScope) => {
    if (target.kind === 'global') return 'All models';
    if (target.kind === 'provider') return `All ${providerById.get(target.providerId)?.label ?? target.providerId}`;
    return modelById.get(target.modelId)?.label ?? target.modelId;
  };

  const activeProvider = scopeProviderId ? providerById.get(scopeProviderId) : undefined;
  const activeValue =
    scope.kind === 'global'
      ? (settings.generalInstructions ?? '')
      : scope.kind === 'provider'
        ? (settings.providerInstructions?.[scope.providerId] ?? '')
        : (settings.modelInstructions?.[scope.modelId] ?? '');
  const activeLabel = scopeLabel(scope);
  const activeBadge =
    scope.kind === 'global' ? 'Global' : scope.kind === 'provider' ? 'Provider' : (activeProvider?.label ?? 'Model');
  const placeholder =
    scope.kind === 'global'
      ? 'e.g. Always run the test suite before reporting a task as done.'
      : scope.kind === 'provider'
        ? `Extra instructions for all ${activeProvider?.label ?? scope.providerId} models (added after Global)…`
        : `Extra instructions only for ${activeLabel} (added after Global${
            activeProvider ? ` and All ${activeProvider.label}` : ''
          })…`;

  // Broader scopes the active one builds on, split by whether they hold text.
  const parents: ScopeChip[] = [];
  if (scope.kind !== 'global') {
    parents.push({ key: 'global', scope: { kind: 'global' }, label: 'Global' });
    if (scope.kind === 'model' && activeProvider) {
      parents.push({
        key: `provider:${activeProvider.id}`,
        scope: { kind: 'provider', providerId: activeProvider.id as ProviderId },
        label: `All ${activeProvider.label}`,
      });
    }
  }
  const parentText = (chip: ScopeChip) =>
    chip.scope.kind === 'global'
      ? settings.generalInstructions
      : chip.scope.kind === 'provider'
        ? settings.providerInstructions?.[chip.scope.providerId]
        : undefined;
  const inheritedScopes = parents.filter((chip) => hasText(parentText(chip)));
  const unfilledParentNames = parents.filter((chip) => !hasText(parentText(chip))).map((chip) => chip.label);

  // Quick-jump pills for every configured scope, once any provider- or
  // model-level instruction exists.
  const configuredChips = useMemo(() => {
    const chips: ScopeChip[] = [];
    if (markedProviderIds.size === 0) return chips;
    if (hasText(settings.generalInstructions)) {
      chips.push({ key: 'global', scope: { kind: 'global' }, label: 'Global' });
    }
    for (const provider of providers) {
      const providerId = provider.id as ProviderId;
      if (hasText(settings.providerInstructions?.[providerId])) {
        chips.push({
          key: `provider:${providerId}`,
          scope: { kind: 'provider', providerId },
          label: `All ${provider.label}`,
          icon: provider.icon,
        });
      }
      for (const model of models) {
        if (model.providerId !== provider.id || !markedModelIds.has(model.id)) continue;
        chips.push({
          key: `model:${model.id}`,
          scope: { kind: 'model', modelId: model.id },
          label: model.label,
          icon: provider.icon,
        });
      }
    }
    return chips;
  }, [markedModelIds, markedProviderIds, models, providers, settings.generalInstructions, settings.providerInstructions]);

  const handleTextChange = (nextText: string) => {
    if (scope.kind === 'global') onChangeGlobal(nextText);
    else if (scope.kind === 'provider') onChangeProvider(scope.providerId, nextText);
    else onChangeModel(scope.modelId, nextText);
  };

  // "All models" and "All <provider>" rows at the top of each provider tab.
  const tabProvider = tab ? providerById.get(tab) : undefined;
  const query = search.trim().toLowerCase();
  const scopeRows: Array<{ key: string; scope: InstructionScope; label: string; sublabel: string; marked: boolean }> =
    [];
  if (!query || ['all models', 'global', 'general'].some((term) => term.includes(query))) {
    scopeRows.push({
      key: 'global',
      scope: { kind: 'global' },
      label: 'All models',
      sublabel: 'Global · every model',
      marked: hasText(settings.generalInstructions),
    });
  }
  if (
    tabProvider &&
    (!query || `all ${tabProvider.label}`.toLowerCase().includes(query) || tabProvider.id.includes(query))
  ) {
    scopeRows.push({
      key: `provider:${tabProvider.id}`,
      scope: { kind: 'provider', providerId: tabProvider.id as ProviderId },
      label: `All ${tabProvider.label}`,
      sublabel: `Provider · every ${tabProvider.label} model`,
      marked: hasText(settings.providerInstructions?.[tabProvider.id as ProviderId]),
    });
  }
  const leadingRows =
    scopeRows.length > 0 ? (
      <>
        {scopeRows.map((row) => {
          const selected = scopeEquals(scope, row.scope);
          const RowIcon = row.scope.kind === 'global' ? Globe : (tabProvider?.icon ?? Globe);
          return (
            <button
              key={row.key}
              type="button"
              className={`model-row ${selected ? 'selected' : ''}`}
              onClick={() => selectScope(row.scope)}
            >
              <RowIcon size={18} />
              <span className="model-row-text">
                <span className="model-row-label">
                  {row.label}
                  {row.marked && (
                    <span
                      className="ml-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)] align-middle"
                      title={HAS_INSTRUCTIONS}
                    />
                  )}
                </span>
                <span className="model-row-provider">{row.sublabel}</span>
              </span>
              {selected && <Check size={15} />}
            </button>
          );
        })}
        <div className="mx-2 my-1 border-t border-[var(--border-subtle)]" />
      </>
    ) : undefined;

  const ActiveIcon = activeProvider?.icon;

  return (
    <div className="setting-row setting-row-stacked">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="setting-label min-w-0 flex-1">
          <div className="setting-label-title">Instructions</div>
          <div className="setting-label-desc">
            Free-form guidance models follow in Durango Code — global applies to all models, while provider and model
            instructions are added after it, without affecting these CLIs outside Durango Code.
          </div>
        </div>

        <div className="model-picker-anchor shrink-0" ref={anchorRef}>
          <button
            type="button"
            className="model-trigger"
            aria-label="Instruction scope"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={toggleOpen}
          >
            {ActiveIcon ? <ActiveIcon size={15} /> : <Globe size={15} />}
            <span>{activeLabel}</span>
            <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
              {activeBadge}
            </span>
            <ChevronDown size={14} className={`model-trigger-chevron ${open ? 'open' : ''}`} />
          </button>

          {open && tab && (
            <ModelPickerPopover
              placement="below"
              className="compact"
              providers={providers}
              models={models}
              activeProviderId={tab}
              onActiveProviderChange={setTab}
              search={search}
              onSearchChange={setSearch}
              selectedModelId={scope.kind === 'model' ? scope.modelId : null}
              onSelect={(model) => selectScope({ kind: 'model', modelId: model.id })}
              leadingRows={leadingRows}
              markedModelIds={markedModelIds}
              markedProviderIds={markedProviderIds}
              markTitle={HAS_INSTRUCTIONS}
              searchPlaceholder="Search models…"
            />
          )}
        </div>
      </div>

      {configuredChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Configured instruction scopes">
          {configuredChips.map((chip) => {
            const active = scopeEquals(scope, chip.scope);
            const ChipIcon = chip.icon ?? Globe;
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => setScope(chip.scope)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                    : 'border-[var(--border-subtle)] bg-white/[0.03] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
                }`}
              >
                <ChipIcon size={11} className="shrink-0 opacity-90" />
                <span>{chip.label}</span>
              </button>
            );
          })}
        </div>
      )}

      <textarea
        className="setting-textarea"
        rows={6}
        aria-label={`${activeLabel} instructions`}
        value={activeValue}
        onChange={(event) => handleTextChange(event.target.value)}
        placeholder={placeholder}
      />

      <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--text-muted)]">
        <div className="flex flex-wrap items-center gap-1">
          {scope.kind === 'global' ? (
            <span>Applies to every model run through Durango Code.</span>
          ) : inheritedScopes.length > 0 ? (
            <>
              <span>Also inherits:</span>
              {inheritedScopes.map((parent, index) => (
                <React.Fragment key={parent.key}>
                  {index > 0 && <span>·</span>}
                  <button
                    type="button"
                    onClick={() => setScope(parent.scope)}
                    className="text-[var(--text-secondary)] underline decoration-white/20 underline-offset-2 transition-colors hover:text-[var(--text-primary)]"
                  >
                    {parent.label}
                  </button>
                </React.Fragment>
              ))}
            </>
          ) : (
            <span>Added after {unfilledParentNames.join(' and ')} instructions (none set yet).</span>
          )}
        </div>

        {hasText(activeValue) && (
          <button
            type="button"
            onClick={() => handleTextChange('')}
            className="shrink-0 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
};
