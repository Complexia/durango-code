import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ProviderRuntimeOptions } from '../store';
import { SelectMenu } from './SelectMenu';
import { installFx, useFxInstall } from './fxInstall';

type FxConnections = NonNullable<Awaited<ReturnType<Window['orion']['getFxConnections']>>['connections']>;
type FxLoginTarget = 'codex' | 'grok' | 'vercel';

type FxConnectionsPanelProps = {
  options: ProviderRuntimeOptions;
  setOptions: (patch: Partial<ProviderRuntimeOptions>) => void;
  accountAuthenticated: boolean;
  onSignInToDurango: () => void;
  /** Start installing as soon as the panel opens (the provider row's Install button). */
  installOnOpen?: boolean;
  onInstallStarted?: () => void;
};

const billedProviderOptions = [
  { value: 'durango', label: 'Durango credits' },
  { value: 'gateway', label: 'Vercel AI Gateway' },
];

/**
 * Where fx runs its models. A connected ChatGPT or Grok subscription always
 * serves that lab's models; everything else goes to the billed provider —
 * Durango credits by default, or the user's own Vercel AI Gateway.
 */
export const FxConnectionsPanel = ({
  options,
  setOptions,
  accountAuthenticated,
  onSignInToDurango,
  installOnOpen = false,
  onInstallStarted,
}: FxConnectionsPanelProps) => {
  const [connections, setConnections] = useState<FxConnections | null>(null);
  const [busyTarget, setBusyTarget] = useState<FxLoginTarget | 'key' | null>(null);
  const { installing, error: installError } = useFxInstall();
  const [gatewayKeyDraft, setGatewayKeyDraft] = useState('');

  const refresh = useCallback(async () => {
    const result = await window.orion?.getFxConnections?.();
    if (result?.ok && result.connections) setConnections(result.connections);
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.orion?.onProviderAuthenticated?.((event) => {
      if (event.providerId === 'fx') void refresh();
    });
    // fx sign-in finishes in the browser; pick up the new login when the
    // user comes back to the window.
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      unsubscribe?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, accountAuthenticated]);

  const install = useCallback(async () => {
    if (await installFx()) await refresh();
  }, [refresh]);

  useEffect(() => {
    if (!installOnOpen) return;
    onInstallStarted?.();
    void install();
  }, [installOnOpen, onInstallStarted, install]);

  const connect = async (target: FxLoginTarget) => {
    setBusyTarget(target);
    try {
      const result = await window.orion.connectFx(target);
      if (result.ok) toast.info('Finish signing in in your browser');
      else toast.error(result.error ?? 'Could not start sign-in');
    } finally {
      setBusyTarget(null);
    }
  };

  const disconnect = async (target: FxLoginTarget) => {
    setBusyTarget(target);
    try {
      const result = await window.orion.disconnectFx(target);
      if (!result.ok) toast.error(result.error ?? 'Could not sign out');
      await refresh();
    } finally {
      setBusyTarget(null);
    }
  };

  const saveGatewayKey = async (key: string | null) => {
    setBusyTarget('key');
    try {
      const result = await window.orion.setFxGatewayApiKey(key);
      if (!result.ok) {
        toast.error(result.error ?? 'Could not save the key');
        return;
      }
      setGatewayKeyDraft('');
      await refresh();
    } finally {
      setBusyTarget(null);
    }
  };

  const durangoEnabled = options.fxDurangoInference !== false;
  const installed = connections?.installed !== false;

  const subscriptionRow = (target: 'codex' | 'grok', label: string, models: string) => {
    const connected = connections?.[target] === true;
    return (
      <div className="provider-option">
        <span className="provider-option-text">
          <span className="provider-option-label">{label}</span>
          <span className="provider-option-description">
            {connected
              ? `Connected. ${models} use this subscription instead of billed inference.`
              : `Not connected. Sign in to run ${models} on your subscription.`}
          </span>
        </span>
        <button
          type="button"
          className="provider-auth-button compact"
          disabled={!installed || busyTarget !== null}
          onClick={() => void (connected ? disconnect(target) : connect(target))}
        >
          {connected ? 'Sign out' : 'Sign in'}
        </button>
      </div>
    );
  };

  return (
    <>
      {(!installed || installing) && (
        <div className="mb-2 flex items-center gap-4 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
          <span className="provider-option-text">
            <span className="provider-option-label">
              {installing ? 'Installing fx…' : 'fx isn’t installed'}
            </span>
            <span className="provider-option-description">
              {installError
                ? `Install failed: ${installError}`
                : 'Downloads the latest fx release from fx.sh into ~/.local/bin and adds it to your shell’s PATH.'}
            </span>
          </span>
          <button
            type="button"
            className="provider-auth-button account-primary-button ml-auto shrink-0"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? 'Installing…' : installError ? 'Try again' : 'Install fx'}
          </button>
        </div>
      )}

      <div className="provider-option">
        <span className="provider-option-text">
          <span className="provider-option-label">Durango credits</span>
          <span className="provider-option-description">
            {accountAuthenticated
              ? 'Models without a connected subscription run on Durango inference and use your account’s usage credits.'
              : 'Sign in to your Durango account to run any model on your usage credits.'}
          </span>
        </span>
        {accountAuthenticated ? (
          <label className="provider-toggle" title={durangoEnabled ? 'Enabled' : 'Disabled'}>
            <input
              type="checkbox"
              checked={durangoEnabled}
              onChange={(event) => setOptions({ fxDurangoInference: event.target.checked })}
            />
            <span />
          </label>
        ) : (
          <button type="button" className="provider-auth-button compact" onClick={onSignInToDurango}>
            Sign in
          </button>
        )}
      </div>

      {subscriptionRow('codex', 'ChatGPT subscription', 'OpenAI models')}
      {subscriptionRow('grok', 'Grok subscription', 'Grok models')}

      <div className="provider-option column">
        <span className="provider-option-text">
          <span className="provider-option-label">Vercel AI Gateway</span>
          <span className="provider-option-description">
            {connections?.gatewaySource === 'api-key'
              ? 'Using the API key saved here.'
              : connections?.gatewaySource === 'fx'
                ? 'Using fx’s own Vercel sign-in or key.'
                : 'Add an AI Gateway API key, or sign in with your Vercel account.'}
          </span>
        </span>
        <div className="flex w-full items-center gap-2">
          <input
            type="password"
            className="provider-option-input min-w-0 flex-1"
            placeholder={connections?.gatewaySource === 'api-key' ? 'Replace saved key' : 'AI Gateway API key'}
            value={gatewayKeyDraft}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setGatewayKeyDraft(event.target.value)}
          />
          <button
            type="button"
            className="provider-auth-button compact"
            disabled={!gatewayKeyDraft.trim() || busyTarget !== null}
            onClick={() => void saveGatewayKey(gatewayKeyDraft.trim())}
          >
            Save
          </button>
          {connections?.gatewaySource === 'api-key' ? (
            <button
              type="button"
              className="provider-auth-button compact"
              disabled={busyTarget !== null}
              onClick={() => void saveGatewayKey(null)}
            >
              Remove
            </button>
          ) : (
            connections?.gatewaySource !== 'fx' && (
              <button
                type="button"
                className="provider-auth-button compact"
                disabled={!installed || busyTarget !== null}
                onClick={() => void connect('vercel')}
              >
                Sign in with Vercel
              </button>
            )
          )}
        </div>
      </div>

      <div className="provider-option">
        <span className="provider-option-text">
          <span className="provider-option-label">Billed provider</span>
          <span className="provider-option-description">
            Tried first for models no connected subscription serves; the other one is the fallback.
          </span>
        </span>
        <SelectMenu
          label="Billed provider"
          value={options.fxBilledProvider === 'gateway' ? 'gateway' : 'durango'}
          options={billedProviderOptions}
          onChange={(value) => setOptions({ fxBilledProvider: value === 'gateway' ? 'gateway' : 'durango' })}
        />
      </div>
    </>
  );
};
