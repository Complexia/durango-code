import React from 'react';
import {
  defaultDurangoDispatchSettings,
  defaultDurangoSettings,
  useOrionStore,
  type DurangoDispatchSettings as DispatchSettings,
} from '../store';
import type { AgentModel, AgentProvider } from '../agentCatalog';
import { SelectMenu } from './SelectMenu';
import { accessModeOptions } from './promptContext';

// Settings → Durango: "Allow Durango Chat and Tasks to start agents on this Mac"
// (merge plan Phase 5; main: src/main/durango-dispatch.js) and the Durango
// Tasks rollback switch.

const statusText = (state: DurangoDispatchState | null, authenticated: boolean) => {
  if (!authenticated) return 'Sign in to your Durango account to use this.';
  if (!state) return 'Starting…';
  const running =
    state.running.length > 0
      ? ` · ${state.running.length} running${
          state.running[0]?.projectName ? ` (${state.running.map((run: DurangoDispatchState['running'][number]) => run.projectName).filter(Boolean).join(', ')})` : ''
        }`
      : '';
  switch (state.status) {
    case 'listening':
      return `Waiting for agents from Durango Chat and Tasks${running}`;
    case 'busy':
      return `At the limit of agents from Durango${running}`;
    case 'offline':
      return 'Offline — will reconnect when this Mac is back online.';
    case 'paused':
      return 'Paused while this Mac sleeps.';
    case 'no_window':
      return 'Open a Durango Code window to run agents from Durango.';
    case 'error':
      return `Can't reach Durango: ${state.lastError ?? 'unknown error'} Retrying…`;
    case 'signed_out':
      return 'Sign in to your Durango account to use this.';
    default:
      return 'Starting…';
  }
};

export const DurangoDispatchSettings: React.FC<{
  authenticated: boolean;
  modelGroups: Array<{ provider: AgentProvider; models: AgentModel[] }>;
}> = ({ authenticated, modelGroups }) => {
  const durangoSettings = useOrionStore((state) => state.durangoSettings ?? defaultDurangoSettings);
  const setDurangoSettings = useOrionStore((state) => state.setDurangoSettings);
  const projects = useOrionStore((state) => state.projects);
  const dispatch: DispatchSettings = { ...defaultDurangoDispatchSettings, ...durangoSettings.dispatch };
  const setDispatch = (updates: Partial<DispatchSettings>) =>
    setDurangoSettings({ dispatch: { ...dispatch, ...updates } });

  const [state, setState] = React.useState<DurangoDispatchState | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void window.orion?.durangoDispatchState?.().then((next) => {
      if (!cancelled) setState(next);
    });
    const off = window.orion?.onDurangoDispatchState?.((next) => setState(next));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const allProjects = dispatch.allowedProjectIds === null;
  const toggleProject = (projectId: string, allowed: boolean) => {
    const current = dispatch.allowedProjectIds ?? projects.map((project) => project.id);
    const next = allowed ? [...new Set([...current, projectId])] : current.filter((id) => id !== projectId);
    setDispatch({ allowedProjectIds: next });
  };

  const modelOptions = [
    { value: '', label: "Project's usual model" },
    ...modelGroups.flatMap((group) =>
      group.models.map((model) => ({ value: model.id, label: `${group.provider.label} · ${model.label}` }))
    ),
  ];
  const accessOptions = accessModeOptions.map((option) => ({
    value: option.value,
    label: option.value === 'read-only' ? 'Read only (recommended)' : option.label,
  }));

  return (
    <>
      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Allow Durango Chat and Tasks to start agents on this Mac</div>
          <div className="setting-label-desc">
            Off by default. When on, you can ask Durango Chat to fix or build something, or press Run
            in Durango Code on a task in Durango Tasks; this Mac picks it up, starts a new thread in
            the matching project, and reports the result back. You get a notification for every agent
            started this way.
            {authenticated && state?.enabled ? ` ${statusText(state, authenticated)}` : ''}
            {!authenticated && ' Requires signing in to your Durango account.'}
          </div>
        </div>
        <label className="provider-toggle" title="Let Durango Chat and Tasks start agents on this Mac">
          <input
            type="checkbox"
            checked={dispatch.enabled}
            disabled={!authenticated && !dispatch.enabled}
            onChange={(e) => setDispatch({ enabled: e.target.checked })}
          />
          <span />
        </label>
      </div>

      {dispatch.enabled && (
        <>
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-title">Access for agents started from Durango</div>
              <div className="setting-label-desc">
                What an agent started from Durango Chat or Tasks may do. Tasks runs get this level; Durango can
                ask for less, never more. Claude asks before every Bash command in Workspace write.
                Prompts from chat can quote chat history or memory, so Read only is safest: the
                agent investigates and proposes changes without editing files.
              </div>
            </div>
            <SelectMenu
              label="Access for agents started from Durango"
              value={dispatch.accessMode}
              options={accessOptions}
              onChange={(value) => setDispatch({ accessMode: value as DispatchSettings['accessMode'] })}
            />
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-title">Default model</div>
              <div className="setting-label-desc">
                Used when Durango doesn't pick one. The project's usual model is the one its most
                recent thread used.
              </div>
            </div>
            <SelectMenu
              label="Default model for agents started from Durango"
              value={dispatch.modelId ?? ''}
              options={modelOptions}
              onChange={(value) => setDispatch({ modelId: value || null })}
            />
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-title">Agents at a time</div>
              <div className="setting-label-desc">
                How many agents from Durango may run at once. With a limit, others wait in Durango until
                one finishes.
              </div>
            </div>
            <SelectMenu
              label="Agents from Durango at a time"
              value={dispatch.maxRunning === null ? 'none' : String(dispatch.maxRunning)}
              options={[
                { value: 'none', label: 'No limit' },
                { value: '1', label: '1 at a time' },
                { value: '2', label: '2 at a time' },
                { value: '4', label: '4 at a time' },
              ]}
              onChange={(value) => setDispatch({ maxRunning: value === 'none' ? null : Number(value) })}
            />
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-title">Projects</div>
              <div className="setting-label-desc">
                Durango Chat only sees, and can only start agents in, the projects allowed here.
              </div>
            </div>
            <label className="provider-toggle" title="Allow every project, including ones added later">
              <input
                type="checkbox"
                checked={allProjects}
                onChange={(e) =>
                  setDispatch({
                    allowedProjectIds: e.target.checked ? null : projects.map((project) => project.id),
                  })
                }
              />
              <span />
            </label>
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-desc">
                {allProjects ? 'All projects, including ones you add later.' : 'Only the checked projects:'}
              </div>
              {!allProjects && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {projects.length === 0 && (
                    <div className="setting-label-desc">No projects yet.</div>
                  )}
                  {projects.map((project) => (
                    <label key={project.id} className="flex cursor-pointer items-center gap-2 text-xs text-[#c8c8c8]">
                      <input
                        type="checkbox"
                        checked={dispatch.allowedProjectIds?.includes(project.id) ?? true}
                        onChange={(e) => toggleProject(project.id, e.target.checked)}
                      />
                      <span className="truncate">{project.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Use Durango Tasks for linked tasks</div>
          <div className="setting-label-desc">
            On by default: the composer's task picker links tasks from Durango Tasks
            (durango.sh/tasks). Turn off only to go back to the old Durango Code web board.
          </div>
        </div>
        <label className="provider-toggle" title="Link tasks from Durango Tasks">
          <input
            type="checkbox"
            checked={durangoSettings.useDurangoTasks !== false}
            onChange={(e) => setDurangoSettings({ useDurangoTasks: e.target.checked })}
          />
          <span />
        </label>
      </div>
    </>
  );
};
