import React from 'react';
import { ChevronDown, Play, RotateCcw, SquareArrowOutUpRight } from 'lucide-react';
import type { DeploymentSettings } from '../store';
import { agentProviders, type AgentModel, type AgentProvider, type AgentProviderId } from '../agentCatalog';
import { ModelPickerPopover } from './ModelPickerPopover';
import { SelectMenu } from './SelectMenu';

// Deploys themselves live in App (the navbar button owns the flow); this panel
// only edits the persisted settings and mirrors the active project's app,
// so it keeps its picker state local like the composer's own mount does.
export type DeploymentsSettingsProps = {
  deploymentSettings: DeploymentSettings;
  setDeploymentSettings: (updates: Partial<DeploymentSettings>) => void;
  /** Same candidate set as the text-generation picker: no Orion, no terminals. */
  deploymentCandidateModels: AgentModel[];
  deploymentProviders: AgentProvider[];
  /** The model a deploy would actually run on right now. */
  resolvedDeploymentModel: AgentModel | null;
  resolvedDeploymentModelId: string | null;
  deploymentReasoningOptions: Array<{ value: string; label: string }>;
  resolvedDeploymentReasoningEffort: string | null;
  /** Orion Cloud app for the active project, when there is one. */
  cloudApp: OrionCloudApp | null;
  onOpenCloudApp: () => void;
};

const appHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const appStatusLabel: Record<OrionCloudAppStatus, string> = {
  queued: 'Queued for build',
  building: 'Building',
  deployed: 'Live',
  failed: 'Last deploy failed',
};

const DeploymentsSettings = React.memo(function DeploymentsSettings({
  deploymentSettings,
  setDeploymentSettings,
  deploymentCandidateModels,
  deploymentProviders,
  resolvedDeploymentModel,
  resolvedDeploymentModelId,
  deploymentReasoningOptions,
  resolvedDeploymentReasoningEffort,
  cloudApp,
  onOpenCloudApp,
}: DeploymentsSettingsProps) {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [providerTab, setProviderTab] = React.useState<AgentProviderId>('claude');
  const pickerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!pickerOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [pickerOpen]);

  const usingDefaultModel = !deploymentSettings.agentModelId;
  const modelLabel = resolvedDeploymentModel
    ? `${resolvedDeploymentModel.label}${usingDefaultModel ? ' (default)' : ''}`
    : 'No model available';

  return (
    <>
      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Deployment agent model</div>
          <div className="setting-label-desc">
            Apps Durango Cloud can build unattended deploy straight from the Deploy button. Anything
            else — monorepos, Compose stacks, repos with no obvious entry point — opens a thread
            where this model deploys the app with the Durango Code CLI (<code>durango-code</code>). Defaults to your
            text-generation model.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!usingDefaultModel && (
            <button
              type="button"
              className="provider-auth-button"
              onClick={() => setDeploymentSettings({ agentModelId: null })}
              title="Use the text-generation model"
            >
              <RotateCcw size={13} />
              Default
            </button>
          )}
          <div className="model-picker-anchor" ref={pickerRef}>
            <button
              className="model-trigger"
              onClick={() => {
                setPickerOpen((open) => {
                  if (!open) {
                    setSearch('');
                    setProviderTab(
                      resolvedDeploymentModel?.providerId ?? deploymentProviders[0]?.id ?? 'claude'
                    );
                  }
                  return !open;
                });
              }}
            >
              {resolvedDeploymentModel &&
                (() => {
                  const ProviderIcon =
                    agentProviders.find((provider) => provider.id === resolvedDeploymentModel.providerId)?.icon ??
                    Play;
                  return <ProviderIcon size={15} />;
                })()}
              <span>{modelLabel}</span>
              <ChevronDown size={14} className={`model-trigger-chevron ${pickerOpen ? 'open' : ''}`} />
            </button>

            {pickerOpen && (
              <ModelPickerPopover
                placement="below"
                className="compact"
                providers={deploymentProviders}
                models={deploymentCandidateModels}
                activeProviderId={providerTab}
                onActiveProviderChange={setProviderTab}
                search={search}
                onSearchChange={setSearch}
                selectedModelId={resolvedDeploymentModelId}
                onSelect={(model) => {
                  setDeploymentSettings({ agentModelId: model.id });
                  setPickerOpen(false);
                  setSearch('');
                }}
              />
            )}
          </div>
          {deploymentReasoningOptions.length > 0 && (
            <SelectMenu
              label="Reasoning effort"
              value={resolvedDeploymentReasoningEffort}
              options={deploymentReasoningOptions}
              onChange={(value) => setDeploymentSettings({ reasoningEffort: value })}
            />
          )}
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Prefer agent deploys</div>
          <div className="setting-label-desc">
            Always hand deploys to the agent, even for apps Durango Code judges simple enough to deploy
            directly. Slower, but you see every step and can steer it.
          </div>
        </div>
        <label className="provider-toggle" title="Always deploy through the deployment agent">
          <input
            type="checkbox"
            checked={deploymentSettings.preferAgentDeploys}
            onChange={(e) => setDeploymentSettings({ preferAgentDeploys: e.target.checked })}
          />
          <span />
        </label>
      </div>

      {cloudApp && (
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">This project</div>
            <div className="setting-label-desc">
              {appStatusLabel[cloudApp.status] ?? cloudApp.status} at {appHost(cloudApp.url)}
              {cloudApp.status === 'failed' && cloudApp.error ? ` — ${cloudApp.error}` : ''}
            </div>
          </div>
          <button
            type="button"
            className="provider-auth-button"
            onClick={onOpenCloudApp}
            disabled={cloudApp.status !== 'deployed'}
          >
            <SquareArrowOutUpRight size={13} />
            Open app
          </button>
        </div>
      )}
    </>
  );
});

export default DeploymentsSettings;
