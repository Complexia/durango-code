import React from 'react';
import { LogIn } from 'lucide-react';
import { defaultDurangoWorkspaceSettings, useOrionStore } from '../store';
import type { DurangoCliStatus } from '../types';

// Settings → Workspaces: automatic Durango workspaces (docs/workspaces.md)
// and the durango-code CLI bundled with the app. The CLI status is main
// process state (the launcher directory, the CLI's own sign-in), so this
// panel fetches it when mounted rather than mirroring it in the store.
const WorkspacesSettings = React.memo(function WorkspacesSettings() {
  const settings = useOrionStore((state) => state.durangoWorkspaceSettings ?? defaultDurangoWorkspaceSettings);
  const setSettings = useOrionStore((state) => state.setDurangoWorkspaceSettings);
  const [cli, setCli] = React.useState<DurangoCliStatus | null>(null);
  const [signingIn, setSigningIn] = React.useState(false);
  const [signInError, setSignInError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const status = await window.orion?.durangoCliStatus?.().catch(() => null);
    setCli(status ?? null);
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = async () => {
    if (!window.orion?.durangoCliSignIn) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const result = await window.orion.durangoCliSignIn();
      if (!result.signedIn) setSignInError(result.error ?? 'The CLI could not be signed in.');
      await refresh();
    } finally {
      setSigningIn(false);
    }
  };

  const cliUser = cli?.user?.name ?? cli?.user?.email ?? null;

  return (
    <>
      <div className="settings-group-label">Durango workspaces</div>
      <div className="settings-group">
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">Create a workspace for each new thread</div>
            <div className="setting-label-desc">
              In repositories with a durango.toml, a new thread&apos;s first message creates its own workspace (
              <code>durango-code ws new</code>): an instant copy of the repository with its dependencies and its own
              port block, so parallel threads never edit the same checkout. The agent works and opens its change from
              there. Threads that already ran keep their directory. Remove a workspace from the thread once its change
              has landed.
            </div>
          </div>
          <label className="provider-toggle" title="Create a workspace for each new thread">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => setSettings({ enabled: e.target.checked })}
            />
            <span />
          </label>
        </div>
      </div>

      <div className="settings-group-label">Durango Code CLI</div>
      <div className="settings-group">
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">Bundled CLI{cli?.version ? ` v${cli.version}` : ''}</div>
            <div className="setting-label-desc">
              {cli && !cli.available
                ? 'This build does not include the durango-code CLI.'
                : 'Agents and the terminal can run durango-code (also ds) without installing it: Durango Code adds it to their PATH. A CLI you installed yourself takes precedence.'}
              {cli?.binDir && (
                <>
                  {' '}
                  <code>{cli.binDir}</code>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">CLI sign-in</div>
            <div className="setting-label-desc">
              {cli?.signedIn
                ? cli.credentialSource === 'environment'
                  ? 'The CLI uses the DURANGO_CODE_TOKEN from your environment.'
                  : `The CLI is signed in${cliUser ? ` as ${cliUser}` : ''}. Sign it out with durango-code logout.`
                : 'Agents need a signed-in CLI to open and land changes. Sign it in with your Durango Code account — the same as running durango-code login.'}
              {signInError && <span className="block text-[var(--danger)]">{signInError}</span>}
            </div>
          </div>
          {cli && !cli.signedIn && (
            <div className="setting-row-actions">
              <button
                type="button"
                className="provider-auth-button"
                disabled={signingIn || !cli.available}
                onClick={() => void signIn()}
              >
                <LogIn size={13} />
                {signingIn ? 'Signing in…' : 'Sign in the CLI'}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
});

export default WorkspacesSettings;
