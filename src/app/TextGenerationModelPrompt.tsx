import React, { useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import type { AgentModel, AgentProvider, AgentProviderId } from '../agentCatalog';
import { ModelPickerPopover } from './ModelPickerPopover';

// Asked once per launch when neither default text-generation model (GPT-6
// Luna, Claude Haiku 5.5) is usable and the user has not picked one in
// Settings → General → Text generation. Picking saves that setting; "Not now"
// leaves titles and commit messages on their non-model fallbacks.
export const TextGenerationModelPrompt: React.FC<{
  providers: AgentProvider[];
  models: AgentModel[];
  onSelect: (model: AgentModel) => void;
  onDismiss: () => void;
}> = ({ providers, models, onSelect, onDismiss }) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeProviderId, setActiveProviderId] = useState<AgentProviderId>(providers[0]?.id ?? 'codex');

  return (
    <div className="modal-backdrop" role="presentation" onClick={onDismiss}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="text-generation-model-title"
        data-testid="text-generation-model-prompt"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="text-generation-model-title" className="modal-title flex items-center gap-2">
          <Sparkles size={16} className="text-sky-400" aria-hidden />
          Choose a model for generated text
        </h2>
        <p className="modal-subtitle">
          Durango Code writes thread titles, commit messages, and PR descriptions with GPT-6 Luna or Claude
          Haiku 5.5, but neither is available. Pick the model to use instead. You can change it anytime in
          Settings → General → Text generation.
        </p>
        <div className="model-picker-anchor mt-4">
          <button
            type="button"
            className="model-trigger"
            onClick={() => {
              setSearch('');
              setPickerOpen((open) => !open);
            }}
          >
            <span>Choose a model</span>
            <ChevronDown size={14} className={`model-trigger-chevron ${pickerOpen ? 'open' : ''}`} />
          </button>
          {pickerOpen && (
            <ModelPickerPopover
              placement="below"
              className="compact"
              providers={providers}
              models={models}
              activeProviderId={activeProviderId}
              onActiveProviderChange={setActiveProviderId}
              search={search}
              onSearchChange={setSearch}
              selectedModelId={null}
              onSelect={(model) => {
                setPickerOpen(false);
                onSelect(model);
              }}
            />
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={onDismiss}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
};
