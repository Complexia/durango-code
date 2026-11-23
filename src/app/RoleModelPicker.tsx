import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Play } from 'lucide-react';
import type { AgentModel, AgentProvider, AgentProviderId } from '../agentCatalog';
import { ModelPickerPopover } from './ModelPickerPopover';

type RoleModelPickerProps = {
  label: string;
  modelGroups: Array<{ provider: AgentProvider; models: AgentModel[] }>;
  value: string;
  onChange: (modelId: string) => void;
};

/** Settings → Orchestration role model: a trigger that opens the shared model picker. */
export const RoleModelPicker: React.FC<RoleModelPickerProps> = ({ label, modelGroups, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<AgentProviderId | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const providers = useMemo(() => modelGroups.map((group) => group.provider), [modelGroups]);
  const models = useMemo(() => modelGroups.flatMap((group) => group.models), [modelGroups]);
  const selected = models.find((model) => model.id === value);
  const SelectedIcon = providers.find((provider) => provider.id === selected?.providerId)?.icon ?? Play;

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

  const toggleOpen = () => {
    if (!open) {
      setSearch('');
      setTab(selected?.providerId ?? providers[0]?.id ?? null);
    }
    setOpen(!open);
  };

  return (
    <div className="model-picker-anchor" ref={anchorRef}>
      <button
        type="button"
        className="model-trigger"
        aria-label={`${label} model`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        {selected && <SelectedIcon size={15} />}
        <span>{selected?.label ?? value ?? 'Choose a model'}</span>
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
          selectedModelId={value}
          onSelect={(model) => {
            onChange(model.id);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
};
