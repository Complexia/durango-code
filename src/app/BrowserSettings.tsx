import { useState } from 'react';
import {
  defaultBrowserSettings,
  useOrionStore,
  type ProviderBrowserMode,
  type ProviderId,
  type ProviderRuntimeOptions,
  type ProviderSettings,
} from '../store';
import { agentProviders } from '../agentCatalog';
import { SelectMenu } from './SelectMenu';

// Providers whose only browser choice is the built-in one (Claude and Codex
// have their own rows).
const BUILTIN_ONLY_PROVIDERS: ProviderId[] = ['grok', 'cursor', 'kimi', 'opencode', 'fx', 'muse'];

/** Claude's setting, migrating the old Claude in Chrome toggle (`chrome: true`). */
export const claudeBrowserMode = (options: ProviderRuntimeOptions | undefined): ProviderBrowserMode =>
  options?.browser === 'builtin' || options?.browser === 'chrome' || options?.browser === 'off'
    ? options.browser
    : options?.chrome === true
      ? 'chrome'
      : 'builtin';

type BrowserSettingsProps = {
  providerSettings: ProviderSettings;
  setProviderOptions: (id: ProviderId, options: Partial<ProviderRuntimeOptions>) => void;
};

/** Settings → Computer Use → Browser use: the built-in browser and Claude's choice. */
export const BuiltinBrowserSettings = ({ providerSettings, setProviderOptions }: BrowserSettingsProps) => {
  const browserSettings = useOrionStore((state) => state.browserSettings ?? defaultBrowserSettings);
  const setBrowserSettings = useOrionStore((state) => state.setBrowserSettings);
  const [clearState, setClearState] = useState<'idle' | 'clearing' | 'cleared' | 'failed'>('idle');

  return (
    <>
      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Open the browser panel when an agent uses it</div>
          <div className="setting-label-desc">
            Durango Code's built-in browser runs beside the chat. When an agent of the thread on screen opens a tab,
            the panel opens so you can watch it and take over.
          </div>
        </div>
        <div className="setting-row-actions">
          <label className="provider-toggle">
            <input
              type="checkbox"
              checked={browserSettings.autoOpenPanel}
              onChange={(event) => setBrowserSettings({ autoOpenPanel: event.target.checked })}
            />
            <span />
          </label>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Ask before downloading files</div>
          <div className="setting-label-desc">
            When a page in the built-in browser starts a download, it waits in the panel until you click Save or
            Cancel. Turn off to save downloads straight to Durango Code's browser downloads folder.
          </div>
        </div>
        <div className="setting-row-actions">
          <label className="provider-toggle">
            <input
              type="checkbox"
              checked={browserSettings.askBeforeDownload}
              onChange={(event) => setBrowserSettings({ askBeforeDownload: event.target.checked })}
            />
            <span />
          </label>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Clear browsing data</div>
          <div className="setting-label-desc">
            Signs the built-in browser out of every site: removes its cookies, storage and cache. Your Chrome is not
            affected.
          </div>
        </div>
        <div className="setting-row-actions">
          <button
            type="button"
            className="provider-auth-button"
            disabled={clearState === 'clearing'}
            onClick={async () => {
              setClearState('clearing');
              const result = await window.orion?.browser?.clearData();
              setClearState(result?.ok ? 'cleared' : 'failed');
            }}
          >
            {clearState === 'clearing'
              ? 'Clearing…'
              : clearState === 'cleared'
                ? 'Cleared'
                : clearState === 'failed'
                  ? 'Try again'
                  : 'Clear data'}
          </button>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Claude</div>
          <div className="setting-label-desc">
            Your Chrome adds Claude in Chrome (--chrome), which drives your real signed-in Chrome through the Claude
            extension: Claude uses it for anything behind a login and the built-in browser for everything else.
          </div>
        </div>
        <div className="setting-row-actions">
          <SelectMenu
            label="Claude browser"
            value={claudeBrowserMode(providerSettings.claude?.options)}
            options={[
              { value: 'chrome', label: 'Your Chrome + built-in' },
              { value: 'builtin', label: 'Built-in only' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(value) =>
              setProviderOptions('claude', {
                browser: value as ProviderBrowserMode,
                chrome: value === 'chrome',
              })
            }
          />
        </div>
      </div>

      {BUILTIN_ONLY_PROVIDERS.map((providerId) => {
        const label = agentProviders.find((provider) => provider.id === providerId)?.label ?? providerId;
        const value = providerSettings[providerId]?.options?.browser === 'off' ? 'off' : 'builtin';
        return (
          <div className="setting-row" key={providerId}>
            <div className="setting-label">
              <div className="setting-label-title">{label}</div>
            </div>
            <div className="setting-row-actions">
              <SelectMenu
                label={`${label} browser`}
                value={value}
                options={[
                  { value: 'builtin', label: 'Built-in browser' },
                  { value: 'off', label: 'Off' },
                ]}
                onChange={(next) => setProviderOptions(providerId, { browser: next as ProviderBrowserMode })}
              />
            </div>
          </div>
        );
      })}
    </>
  );
};

export default BuiltinBrowserSettings;
