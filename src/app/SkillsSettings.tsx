import React from 'react';
import { FileCode2, FolderOpen, FolderPlus, RefreshCw, Trash2 } from 'lucide-react';
import type { SkillEntry, SkillImportResult } from '../types';

// Skills are managed straight on disk (~/.claude/skills), so this panel keeps
// its own state instead of routing through App: nothing here is shared with
// the rest of the shell, and the tab is only mounted while it is open.
export type SkillsSettingsProps = {
  formatBytes: (bytes: number | null | undefined) => string;
  onOpenInEditor: (skill: { path: string; skillFile?: string; name: string }) => void;
};

const summarizeImport = (results: SkillImportResult[]) => {
  const imported = results.filter((entry) => entry.status === 'imported');
  const replaced = results.filter((entry) => entry.status === 'replaced');
  const skipped = results.filter((entry) => entry.status === 'skipped');
  const failed = results.filter((entry) => entry.status === 'error');
  const parts: string[] = [];
  if (imported.length > 0) parts.push(`Imported ${imported.length} skill${imported.length === 1 ? '' : 's'}`);
  if (replaced.length > 0) parts.push(`replaced ${replaced.length}`);
  if (skipped.length > 0) parts.push(`skipped ${skipped.length}`);
  const summary = parts.length > 0 ? `${parts.join(', ')}.` : '';
  const errors = failed.map((entry) => `${entry.id}: ${entry.error || 'Import failed.'}`);
  return [summary, ...errors].filter(Boolean).join(' ');
};

const SkillsSettings = React.memo(function SkillsSettings({ formatBytes, onOpenInEditor }: SkillsSettingsProps) {
  const [skills, setSkills] = React.useState<SkillEntry[]>([]);
  const [skillsPath, setSkillsPath] = React.useState('~/.claude/skills');
  const [loading, setLoading] = React.useState(true);
  const [importing, setImporting] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // `preserveMessage` keeps an action's failure on screen: every mutation
  // re-lists afterwards, and a bare refresh would otherwise clear the error it
  // was called to report.
  const refresh = React.useCallback(async (options?: { preserveMessage?: boolean }) => {
    if (!window.orion?.listSkills) {
      setLoading(false);
      setError('This build of Durango Code cannot manage skills. Restart the app after updating.');
      return;
    }
    setLoading(true);
    try {
      const result = await window.orion.listSkills();
      if (!mountedRef.current) return;
      setSkills(result?.skills ?? []);
      if (result?.skillsPath) setSkillsPath(result.skillsPath);
      if (result?.ok === false) setError(result.error ?? 'Could not read your skills folder.');
      else if (!options?.preserveMessage) setError(null);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Notices report a finished action; they shouldn't linger over the next one.
  React.useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const handleImport = React.useCallback(async () => {
    if (!window.orion?.importSkills) return;
    setImporting(true);
    try {
      const result = await window.orion.importSkills();
      if (!mountedRef.current) return;
      if (result?.cancelled) return;
      const summary = summarizeImport(result?.results ?? []);
      setNotice(summary || 'Nothing to import.');
      await refresh();
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  }, [refresh]);

  const handleToggle = React.useCallback(
    async (skill: SkillEntry, enabled: boolean) => {
      if (!window.orion?.setSkillEnabled) return;
      setBusyId(skill.id);
      // Optimistic: the move is a rename, so the only realistic failure is a
      // name collision, which the refresh below puts right.
      setSkills((current) => current.map((entry) => (entry.id === skill.id ? { ...entry, enabled } : entry)));
      let failed = false;
      try {
        const result = await window.orion.setSkillEnabled({ id: skill.id, enabled });
        if (!mountedRef.current) return;
        failed = !result?.ok;
        if (failed) setError(result?.error ?? `Could not ${enabled ? 'activate' : 'deactivate'} ${skill.name}.`);
        else setError(null);
      } catch (caught) {
        failed = true;
        if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (mountedRef.current) setBusyId(null);
        await refresh({ preserveMessage: failed });
      }
    },
    [refresh]
  );

  const handleDelete = React.useCallback(
    async (skill: SkillEntry) => {
      if (!window.orion?.deleteSkill) return;
      setBusyId(skill.id);
      let failed = false;
      try {
        const result = await window.orion.deleteSkill({ id: skill.id, path: skill.path, enabled: skill.enabled });
        if (!mountedRef.current) return;
        if (result?.cancelled) return;
        failed = !result?.ok;
        if (failed) setError(result?.error ?? `Could not delete ${skill.name}.`);
        else {
          setError(null);
          setNotice(`Moved “${skill.name}” to the Trash.`);
        }
      } catch (caught) {
        failed = true;
        if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (mountedRef.current) setBusyId(null);
        await refresh({ preserveMessage: failed });
      }
    },
    [refresh]
  );

  const query = search.trim().toLowerCase();
  const visibleSkills = query
    ? skills.filter((skill) =>
        `${skill.name} ${skill.id} ${skill.description}`.toLowerCase().includes(query)
      )
    : skills;
  const activeCount = skills.filter((skill) => skill.enabled).length;

  return (
    <>
      <div className="settings-group-label">Installed skills</div>
      <div className="settings-group">
        <div className="skills-toolbar">
          <div className="skills-toolbar-main">
            <div className="skills-toolbar-total">
              {loading && skills.length === 0
                ? 'Reading skills...'
                : `${skills.length} skill${skills.length === 1 ? '' : 's'} · ${activeCount} active`}
            </div>
            <div className="skills-toolbar-caption">
              Skills are folders in <span className="skills-path">{skillsPath}</span>, each with a SKILL.md that tells
              agents when to use it. Active skills are offered to every agent Durango Code runs, in every project.
              Deactivating one parks its folder next door so nothing loads it.
            </div>
          </div>
          <div className="skills-toolbar-actions">
            <button
              type="button"
              className="btn small"
              disabled={importing}
              onClick={() => void handleImport()}
              title="Import a skill folder, its SKILL.md, or a .zip archive"
            >
              <FolderPlus size={13} />
              {importing ? 'Importing...' : 'Import skill'}
            </button>
            <button
              type="button"
              className="btn secondary small"
              disabled={loading}
              onClick={() => void refresh()}
              title="Re-read the skills folder"
            >
              <RefreshCw size={13} className={loading ? 'spinning' : ''} />
              Refresh
            </button>
            <button
              type="button"
              className="btn secondary small"
              onClick={() => void window.orion?.openSkillsFolder?.()}
              title="Open the skills folder"
            >
              <FolderOpen size={13} />
              Open folder
            </button>
          </div>
        </div>

        {(error || notice) && (
          <div className={`skills-message${error ? ' error' : ''}`}>{error || notice}</div>
        )}

        {skills.length > 6 && (
          <div className="skills-filter">
            <input
              type="text"
              className="skills-filter-input"
              placeholder="Filter skills"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        )}

        {!loading && skills.length === 0 && !error && (
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-desc">
                No skills installed yet. Import a skill folder (or a .zip of one) to make it available to your agents.
              </div>
            </div>
          </div>
        )}

        {skills.length > 0 && visibleSkills.length === 0 && (
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-desc">No skill matches “{search.trim()}”.</div>
            </div>
          </div>
        )}

        {visibleSkills.length > 0 && (
          <div className="skills-list">
            {visibleSkills.map((skill) => {
              const busy = busyId === skill.id;
              return (
                // Keyed by path, not id: the same id can exist in both roots if
                // the folders were moved by hand.
                <div key={skill.path} className={`skills-row${skill.enabled ? '' : ' inactive'}`}>
                  <div className="skills-row-main">
                    <div className="skills-row-head">
                      <button
                        type="button"
                        className="skills-row-name truncate"
                        title={`Edit ${skill.id}/SKILL.md in the Code tab`}
                        onClick={() => onOpenInEditor(skill)}
                      >
                        {skill.name}
                      </button>
                      {skill.version && <span className="provider-version">v{skill.version}</span>}
                      {!skill.enabled && <span className="provider-status-chip">Inactive</span>}
                    </div>
                    <div className="skills-row-desc" title={skill.description || undefined}>
                      {skill.description || 'No description in SKILL.md — agents will rarely pick this skill.'}
                    </div>
                    <div className="skills-row-meta truncate" title={skill.path}>
                      {skill.id} · {skill.files} file{skill.files === 1 ? '' : 's'} · {formatBytes(skill.bytes)}
                    </div>
                  </div>
                  <label
                    className="provider-toggle"
                    title={skill.enabled ? 'Deactivate this skill' : 'Activate this skill'}
                  >
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      disabled={busy}
                      onChange={(event) => void handleToggle(skill, event.target.checked)}
                    />
                    <span />
                  </label>
                  <button
                    type="button"
                    className="archived-epic-action"
                    title="Open in the Code tab"
                    disabled={busy}
                    onClick={() => onOpenInEditor(skill)}
                  >
                    <FileCode2 size={13} />
                  </button>
                  <button
                    type="button"
                    className="archived-epic-action"
                    title="Reveal in Finder"
                    disabled={busy}
                    onClick={() =>
                      void window.orion?.revealSkill?.({ id: skill.id, path: skill.path, enabled: skill.enabled })
                    }
                  >
                    <FolderOpen size={13} />
                  </button>
                  <button
                    type="button"
                    className="archived-epic-action danger"
                    title="Delete this skill"
                    disabled={busy}
                    onClick={() => void handleDelete(skill)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
});

export default SkillsSettings;
