import React, { useMemo, useState } from 'react';
import { Check, Loader2, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentModel } from '../agentCatalog';
import { ClaudeBrandIcon, CodexBrandIcon, OrionBrandIcon } from '../providerIcons';
import { type Project, type Thread, useOrionStore } from '../store';
import type { ImportableSessionSummary, ImportedSessionTranscript } from '../types';

type ImportProviderId = ImportableSessionSummary['providerId'];

const PROVIDER_LABELS: Record<ImportProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

// Transcripts are read a few sessions per IPC round trip so no single
// response carries a large slice of history, and the sidebar fills in as it
// goes.
const READ_BATCH_SIZE = 8;

const RANGES = [
  { id: '24h', label: '24 hours', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

type Phase =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'ready'; sessions: ImportableSessionSummary[]; range: RangeId }
  | { kind: 'importing'; done: number; total: number }
  | { kind: 'done'; imported: number; projectsAdded: number };

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');

const folderName = (value: string) => normalizePath(value).split('/').filter(Boolean).at(-1) ?? value;

const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

/** Every provider session id Orion already owns, imported or native. */
const knownSessionIds = (threads: Thread[]) => {
  const ids = new Set<string>();
  for (const thread of threads) {
    for (const id of Object.values(thread.agentSessionIds ?? {})) if (id) ids.add(id);
    if (thread.importedFrom?.sessionId) ids.add(thread.importedFrom.sessionId);
  }
  return ids;
};

const inRange = (session: ImportableSessionSummary, range: RangeId) => {
  const days = RANGES.find((candidate) => candidate.id === range)?.days ?? null;
  if (days === null) return true;
  return Date.parse(session.updatedAt) >= Date.now() - days * 24 * 60 * 60 * 1000;
};

// The thread resumes the provider session, so it must run on a model of that
// provider — an unknown id would silently fall back to the global default.
const resolveImportedModelId = (
  models: AgentModel[],
  providerId: ImportProviderId,
  slug: string | null
) => {
  const providerModels = models.filter(
    (model) => model.providerId === providerId && model.id !== 'claude:claude-code-cli'
  );
  if (slug) {
    const candidates = [slug, slug.replace(/-\d{8}$/, '')];
    for (const candidate of candidates) {
      const match = providerModels.find((model) => model.slug === candidate);
      if (match) return match.id;
    }
  }
  return (providerModels.find((model) => model.favorite) ?? providerModels[0])?.id ?? `${providerId}:${slug ?? 'default'}`;
};

const toThread = (
  transcript: ImportedSessionTranscript,
  projectId: string,
  models: AgentModel[]
): Thread => ({
  id: crypto.randomUUID(),
  projectId,
  title: transcript.title || `${PROVIDER_LABELS[transcript.providerId]} conversation`,
  status: 'done',
  modelId: resolveImportedModelId(models, transcript.providerId, transcript.model),
  accessMode: 'full-access',
  createdAt: transcript.createdAt ?? transcript.messages[0]?.ts ?? new Date().toISOString(),
  agentSessionIds: { [transcript.providerId]: transcript.sessionId },
  importedFrom: {
    providerId: transcript.providerId,
    sessionId: transcript.sessionId,
    importedAt: new Date().toISOString(),
  },
  importedUnseen: true,
  messages: transcript.messages,
});

export const SessionImportCard: React.FC<{ agentModels: AgentModel[] }> = ({ agentModels }) => {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const scan = async () => {
    if (!window.orion?.scanImportableSessions) return;
    setPhase({ kind: 'scanning' });
    const result = await window.orion
      .scanImportableSessions({ excludeSessionIds: [...knownSessionIds(useOrionStore.getState().threads)] })
      .catch((error: unknown) => ({ ok: false as const, error: String(error) }));
    if (!result.ok) {
      toast.error('Could not look for conversations', { description: result.error });
      setPhase({ kind: 'idle' });
      return;
    }
    if (result.sessions.length === 0) {
      toast('Everything is already imported', {
        description: 'No new Claude Code or Codex conversations were found.',
      });
      setPhase({ kind: 'idle' });
      return;
    }
    const hasRecent = result.sessions.some((session) => inRange(session, '30d'));
    setPhase({ kind: 'ready', sessions: result.sessions, range: hasRecent ? '30d' : 'all' });
  };

  const runImport = async (sessions: ImportableSessionSummary[]) => {
    if (!window.orion?.readImportableSessions || sessions.length === 0) return;
    setPhase({ kind: 'importing', done: 0, total: sessions.length });
    let imported = 0;
    let projectsAdded = 0;
    let failed = 0;
    for (let offset = 0; offset < sessions.length; offset += READ_BATCH_SIZE) {
      const batch = sessions.slice(offset, offset + READ_BATCH_SIZE);
      const result = await window.orion
        .readImportableSessions({
          sessions: batch.map(({ providerId, filePath }) => ({ providerId, filePath })),
        })
        .catch((error: unknown) => ({ ok: false as const, error: String(error) }));
      if (!result.ok) {
        failed += batch.length;
      } else {
        // Re-read the store per batch: the user may have added a project or
        // started a thread while the import runs.
        const state = useOrionStore.getState();
        const known = knownSessionIds(state.threads);
        const projectsByPath = new Map(state.projects.map((project) => [normalizePath(project.path), project]));
        const newProjects: Project[] = [];
        const threads: Thread[] = [];
        for (const transcript of result.sessions) {
          if (!transcript) {
            failed += 1;
            continue;
          }
          if (known.has(transcript.sessionId) || !transcript.cwd) continue;
          const key = normalizePath(transcript.cwd);
          let project = projectsByPath.get(key);
          if (!project) {
            project = { id: crypto.randomUUID(), name: folderName(transcript.cwd), path: transcript.cwd };
            projectsByPath.set(key, project);
            newProjects.push(project);
          }
          known.add(transcript.sessionId);
          threads.push(toThread(transcript, project.id, agentModels));
        }
        state.importThreads({ projects: newProjects, threads });
        imported += threads.length;
        projectsAdded += newProjects.length;
      }
      setPhase({ kind: 'importing', done: Math.min(offset + batch.length, sessions.length), total: sessions.length });
    }
    if (failed > 0) {
      toast.error(`${plural(failed, 'conversation')} could not be imported`);
    }
    setPhase({ kind: 'done', imported, projectsAdded });
  };

  const selection = useMemo(() => {
    if (phase.kind !== 'ready') return null;
    const sessions = phase.sessions.filter((session) => inRange(session, phase.range));
    const projectPaths = new Set(useOrionStore.getState().projects.map((project) => normalizePath(project.path)));
    const folders = new Map<string, number>();
    const byProvider: Record<ImportProviderId, number> = { claude: 0, codex: 0 };
    for (const session of sessions) {
      const key = normalizePath(session.cwd);
      folders.set(key, (folders.get(key) ?? 0) + 1);
      byProvider[session.providerId] += 1;
    }
    const newFolders = [...folders.keys()].filter((key) => !projectPaths.has(key));
    return {
      sessions,
      byProvider,
      folders: [...folders.entries()].sort((a, b) => b[1] - a[1]),
      newFolders: new Set(newFolders),
    };
  }, [phase]);

  if (!window.orion?.scanImportableSessions) return null;

  const busy = phase.kind === 'scanning' || phase.kind === 'importing';
  const subtitle =
    phase.kind === 'scanning'
      ? 'Looking for conversations…'
      : phase.kind === 'importing'
        ? `Importing ${phase.done.toLocaleString()} of ${plural(phase.total, 'conversation')}…`
        : phase.kind === 'done'
          ? `Imported ${plural(phase.imported, 'conversation')}${
              phase.projectsAdded > 0 ? ` and added ${plural(phase.projectsAdded, 'project')}` : ''
            }`
          : 'Sync your chats and continue them in Durango Code';

  return (
    <div className={`session-import ${phase.kind === 'ready' ? 'expanded' : ''}`}>
      <button
        type="button"
        className="session-import-trigger"
        onClick={() => {
          if (phase.kind === 'ready') setPhase({ kind: 'idle' });
          else if (!busy) void scan();
        }}
        disabled={busy}
        aria-expanded={phase.kind === 'ready'}
      >
        <span className="session-import-logos" aria-hidden>
          <span className="session-import-logo claude">
            <ClaudeBrandIcon size={13} />
          </span>
          <span className="session-import-logo codex">
            <CodexBrandIcon size={13} />
          </span>
          <MoreHorizontal size={14} className="session-import-dots" />
          <span className="session-import-logo orion">
            <OrionBrandIcon size={18} />
          </span>
        </span>
        <span className="session-import-copy">
          <span className="session-import-title">Import your Claude Code &amp; Codex conversations</span>
          <span className="session-import-subtitle">
            {busy && <Loader2 size={12} className="animate-spin" />}
            {phase.kind === 'done' && <Check size={12} />}
            {subtitle}
          </span>
        </span>
      </button>

      {phase.kind === 'ready' && selection && (
        <div className="session-import-panel">
          <div className="session-import-ranges" role="radiogroup" aria-label="Import range">
            {RANGES.map((range) => {
              const count = phase.sessions.filter((session) => inRange(session, range.id)).length;
              return (
                <button
                  key={range.id}
                  type="button"
                  role="radio"
                  aria-checked={phase.range === range.id}
                  className={`session-import-range ${phase.range === range.id ? 'selected' : ''}`}
                  onClick={() => setPhase({ ...phase, range: range.id })}
                >
                  {range.label}
                  <span className="session-import-range-count">{count.toLocaleString()}</span>
                </button>
              );
            })}
          </div>
          <p className="session-import-summary">
            {selection.sessions.length === 0
              ? 'No conversations in this range.'
              : `${plural(selection.sessions.length, 'conversation')} (${[
                  selection.byProvider.claude > 0 && `${selection.byProvider.claude.toLocaleString()} Claude Code`,
                  selection.byProvider.codex > 0 && `${selection.byProvider.codex.toLocaleString()} Codex`,
                ]
                  .filter(Boolean)
                  .join(', ')}) from ${plural(selection.folders.length, 'folder')}.${
                  selection.newFolders.size > 0
                    ? ` ${plural(selection.newFolders.size, 'folder')} not in Durango Code yet will be added as ${
                        selection.newFolders.size === 1 ? 'a project' : 'projects'
                      }.`
                    : ''
                }`}
          </p>
          {selection.folders.length > 0 && (
            <ul className="session-import-folders">
              {selection.folders.slice(0, 6).map(([folder, count]) => (
                <li key={folder} title={folder}>
                  <span className="truncate">{folderName(folder)}</span>
                  {selection.newFolders.has(folder) && <span className="session-import-new">new</span>}
                  <span className="session-import-folder-count">{count.toLocaleString()}</span>
                </li>
              ))}
              {selection.folders.length > 6 && (
                <li className="session-import-more">+{plural(selection.folders.length - 6, 'more folder')}</li>
              )}
            </ul>
          )}
          <div className="session-import-actions">
            <button type="button" className="btn secondary small" onClick={() => setPhase({ kind: 'idle' })}>
              Cancel
            </button>
            <button
              type="button"
              className="btn small"
              disabled={selection.sessions.length === 0}
              onClick={() => void runImport(selection.sessions)}
            >
              Import {selection.sessions.length > 0 ? selection.sessions.length.toLocaleString() : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
