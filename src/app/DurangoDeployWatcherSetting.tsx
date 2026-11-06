import React from 'react';
import { defaultDurangoDeployWatcherSettings, defaultDurangoSettings, useOrionStore } from '../store';

// Settings → Durango: "Deploy changes landed elsewhere" (main:
// src/main/durango-deploy-watcher.js). Off by default: deploys run on this Mac
// with its own provider logins.

type RepoState = DurangoDeployWatcherState['repos'][number];

const timeOf = (iso: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const repoLine = (repo: RepoState) => {
  const targets = repo.pending.join(', ');
  switch (repo.state) {
    case 'started':
      return `${repo.name}: started deploying ${targets} at ${timeOf(repo.startedAt)}.`;
    case 'deploying':
      return `${repo.name}: deploying ${targets}.`;
    case 'stalled':
      return `${repo.name}: ${targets} still pending after the runner started at ${timeOf(repo.startedAt)}; it tries again later.`;
    case 'error':
      return `${repo.name}: ${repo.error ?? 'could not check deploys.'}`;
    case 'unavailable':
      return `${repo.name}: Durango Source refused access (${repo.error ?? 'not found'}).`;
    default:
      return `${repo.name}: nothing to deploy.`;
  }
};

const statusText = (state: DurangoDeployWatcherState | null) => {
  if (!state) return 'Starting…';
  switch (state.status) {
    case 'watching':
      return state.repos.length === 0
        ? 'No project here has a Durango Source repository with deploy commands in its durango.toml.'
        : `Watching ${state.repos.map((repo) => repo.name).join(', ')}.`;
    case 'offline':
      return 'Offline: checks again when this Mac is back online.';
    case 'paused':
      return 'Paused while this Mac sleeps.';
    case 'error':
      return `Can't reach Durango Source: ${state.lastError ?? 'unknown error'} Retrying…`;
    case 'signed_out':
      return 'Sign in to your Durango account to use this.';
    default:
      return 'Starting…';
  }
};

export const DurangoDeployWatcherSetting: React.FC<{ authenticated: boolean }> = ({ authenticated }) => {
  const durangoSettings = useOrionStore((state) => state.durangoSettings ?? defaultDurangoSettings);
  const setDurangoSettings = useOrionStore((state) => state.setDurangoSettings);
  const settings = { ...defaultDurangoDeployWatcherSettings, ...durangoSettings.deployWatcher };

  const [state, setState] = React.useState<DurangoDeployWatcherState | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void window.orion?.durangoDeployWatcherState?.().then((next) => {
      if (!cancelled) setState(next);
    });
    const off = window.orion?.onDurangoDeployWatcherState?.((next) => setState(next));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const active = authenticated && settings.enabled && state?.enabled;
  const busyRepos = active ? (state?.repos ?? []).filter((repo) => repo.state !== 'idle') : [];

  return (
    <div className="setting-row">
      <div className="setting-label">
        <div className="setting-label-title">Deploy changes landed elsewhere</div>
        <div className="setting-label-desc">
          Off by default. When on, changes landed from the web, the Durango MCP or another machine
          deploy from this Mac as if you had landed them here: the repository's durango.toml deploy
          commands run in the background with this Mac's railway, convex and wrangler logins, and
          keep going if Durango Code quits.
          {active ? ` ${statusText(state)}` : ''}
          {!authenticated && ' Requires signing in to your Durango account.'}
        </div>
        {busyRepos.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {busyRepos.map((repo) => (
              <div key={repo.repoId} className="setting-label-desc">
                {repoLine(repo)}
                {repo.log && (repo.state === 'started' || repo.state === 'deploying' || repo.state === 'stalled') && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="underline hover:text-[#e0e0e0]"
                      onClick={() => void window.orion?.durangoOpenDeployLog?.({ log: repo.log ?? '' })}
                    >
                      Open log
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <label className="provider-toggle" title="Deploy changes landed elsewhere from this Mac">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={!authenticated && !settings.enabled}
          onChange={(e) => setDurangoSettings({ deployWatcher: { ...settings, enabled: e.target.checked } })}
        />
        <span />
      </label>
    </div>
  );
};
