import React from 'react';
import { Archive, Check, ChevronDown, FolderPlus, GitCommit, GitPullRequest, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import type { Epic, Project } from '../store';
import type { RiftStorageEntry } from '../types';
import type {
  AddProjectToEpicDialogState,
  EpicCommitDialogState,
  EpicPrBaseDialogState,
  EpicSettleDialogState,
  NewEpicRiftBranches,
  RiftSweepDialogState,
} from './appTypes';
import { ProjectIcon } from './ProjectIcon';

export type AppDialogsModel = {
  projects: Project[];
  epics: Epic[];
  addProjectToEpicDialog: AddProjectToEpicDialogState | null;
  setAddProjectToEpicDialog: React.Dispatch<React.SetStateAction<AddProjectToEpicDialogState | null>>;
  handleAddProjectToEpic: () => Promise<void>;
  createEpicOpen: boolean;
  newEpicName: string;
  setNewEpicName: React.Dispatch<React.SetStateAction<string>>;
  newEpicDescription: string;
  setNewEpicDescription: React.Dispatch<React.SetStateAction<string>>;
  newEpicProjectIds: string[];
  setNewEpicProjectIds: React.Dispatch<React.SetStateAction<string[]>>;
  setCreateEpicProjectPickerIndex: React.Dispatch<React.SetStateAction<number | null>>;
  createEpicProjectPickerIndex: number | null;
  setCreateEpicRiftBranchPickerOpen: React.Dispatch<React.SetStateAction<number | null>>;
  createEpicRiftBranchPickerOpen: number | null;
  newEpicCreateRift: boolean;
  setNewEpicCreateRift: React.Dispatch<React.SetStateAction<boolean>>;
  newEpicRiftBaseBranches: Record<string, string | null>;
  setNewEpicRiftBaseBranches: React.Dispatch<React.SetStateAction<Record<string, string | null>>>;
  newEpicRiftBranches: NewEpicRiftBranches;
  createEpicTitleRef: React.RefObject<HTMLInputElement | null>;
  createEpicProjectPickerRef: React.RefObject<HTMLDivElement | null>;
  riftsActive: boolean;
  closeCreateEpicModal: () => void;
  handleCreateEpic: () => void;
  epicCommitDialog: EpicCommitDialogState | null;
  setEpicCommitDialog: React.Dispatch<React.SetStateAction<EpicCommitDialogState | null>>;
  handleEpicCommitAndPush: (epic: Epic, message?: string) => Promise<void>;
  epicPrBaseDialog: EpicPrBaseDialogState | null;
  setEpicPrBaseDialog: React.Dispatch<React.SetStateAction<EpicPrBaseDialogState | null>>;
  setEpicPrBaseBranchPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  epicPrBaseBranchPickerOpen: boolean;
  epicPrBaseBranchPickerRef: React.RefObject<HTMLDivElement | null>;
  handleEpicCreatePr: (epic: Epic, baseBranch: string, message?: string) => Promise<void>;
  epicSettleDialog: EpicSettleDialogState | null;
  setEpicSettleDialog: React.Dispatch<React.SetStateAction<EpicSettleDialogState | null>>;
  confirmEpicSettlement: (epic: Epic, releaseRift?: boolean) => void;
  riftSweepDialog: RiftSweepDialogState | null;
  setRiftSweepDialog: React.Dispatch<React.SetStateAction<RiftSweepDialogState | null>>;
  dismissRiftSweepDialog: () => void;
  releaseRiftStorage: (
    entries: Array<Pick<RiftStorageEntry, 'riftPath'>>,
    options?: {
      runGc?: boolean;
      forcePaths?: string[];
      manualPaths?: string[];
      manualScanId?: string;
      queueIfBusy?: boolean;
    }
  ) => Promise<void>;
  formatBytes: (bytes: number | null | undefined) => string;
};

const AppDialogs = React.memo(function AppDialogs({ model }: { model: AppDialogsModel }) {
  const {
    projects,
    epics,
    addProjectToEpicDialog,
    setAddProjectToEpicDialog,
    handleAddProjectToEpic,
    createEpicOpen,
    newEpicName,
    setNewEpicName,
    newEpicDescription,
    setNewEpicDescription,
    newEpicProjectIds,
    setNewEpicProjectIds,
    setCreateEpicProjectPickerIndex,
    createEpicProjectPickerIndex,
    setCreateEpicRiftBranchPickerOpen,
    createEpicRiftBranchPickerOpen,
    newEpicCreateRift,
    setNewEpicCreateRift,
    newEpicRiftBaseBranches,
    setNewEpicRiftBaseBranches,
    newEpicRiftBranches,
    createEpicTitleRef,
    createEpicProjectPickerRef,
    riftsActive,
    closeCreateEpicModal,
    handleCreateEpic,
    epicCommitDialog,
    setEpicCommitDialog,
    handleEpicCommitAndPush,
    epicPrBaseDialog,
    setEpicPrBaseDialog,
    setEpicPrBaseBranchPickerOpen,
    epicPrBaseBranchPickerOpen,
    epicPrBaseBranchPickerRef,
    handleEpicCreatePr,
    epicSettleDialog,
    setEpicSettleDialog,
    confirmEpicSettlement,
    riftSweepDialog,
    setRiftSweepDialog,
    dismissRiftSweepDialog,
    releaseRiftStorage,
    formatBytes,
  } = model;

  const addProjectEpic = addProjectToEpicDialog
    ? epics.find((epic) => epic.id === addProjectToEpicDialog.epicId) ?? null
    : null;
  const existingEpicProjectIds = new Set([
    ...(addProjectEpic?.repositories ?? []).map((repository) => repository.projectId),
    ...(addProjectEpic?.repositoryProjectId ? [addProjectEpic.repositoryProjectId] : []),
  ]);
  const addProjectCandidates = projects.filter(
    (project) => !existingEpicProjectIds.has(project.id)
  );

  return (
    <>
      {addProjectToEpicDialog && addProjectEpic && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!addProjectToEpicDialog.submitting) setAddProjectToEpicDialog(null);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-project-to-epic-title"
            onClick={(event) => event.stopPropagation()}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleAddProjectToEpic();
              }}
            >
              <h2 id="add-project-to-epic-title" className="modal-title">
                Add project to “{addProjectEpic.name}”
              </h2>
              <p className="modal-subtitle">
                Durango Code will create a Rift copy on this epic’s feature branch and add it to the shared workspace.
              </p>
              <div className="modal-field">
                <span className="modal-field-label">Project</span>
                <div
                  role="listbox"
                  aria-label="Project to add"
                  className="max-h-64 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] p-1"
                >
                  {addProjectCandidates.map((project) => {
                    const selected = project.id === addProjectToEpicDialog.projectId;
                    return (
                      <button
                        key={project.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        disabled={addProjectToEpicDialog.submitting}
                        title={project.path}
                        className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] border-0 px-2.5 py-2 text-left text-[13px] transition-colors ${
                          selected
                            ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                            : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                        } disabled:cursor-not-allowed disabled:opacity-60`}
                        onClick={() =>
                          setAddProjectToEpicDialog((current) =>
                            current ? { ...current, projectId: project.id } : current
                          )
                        }
                      >
                        <ProjectIcon projectPath={project.path} size={14} />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        {selected && <Check size={13} className="shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn secondary"
                  disabled={addProjectToEpicDialog.submitting}
                  onClick={() => setAddProjectToEpicDialog(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn"
                  disabled={
                    addProjectToEpicDialog.submitting ||
                    !addProjectCandidates.some(
                      (project) => project.id === addProjectToEpicDialog.projectId
                    )
                  }
                >
                  {addProjectToEpicDialog.submitting ? (
                    <LoaderCircle size={14} className="animate-spin" />
                  ) : (
                    <FolderPlus size={14} />
                  )}
                  {addProjectToEpicDialog.submitting ? 'Adding project…' : 'Add project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {epicCommitDialog && (
        <div className="modal-backdrop" role="presentation" onClick={() => setEpicCommitDialog(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="epic-commit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="epic-commit-title" className="modal-title">
              {epicCommitDialog.epic.commitWithoutPush ? 'Commit' : 'Commit & push'}
            </h2>
            <p className="modal-subtitle">
              Stages everything in {epicCommitDialog.epic.riftPath ? 'this epic’s rift' : 'the repository'}, then
              {epicCommitDialog.epic.commitWithoutPush ? ' commits without pushing.' : ' pushes.'}
            </p>
            <form
              className="modal-form"
              onSubmit={(e) => {
                e.preventDefault();
                const dialog = epicCommitDialog;
                setEpicCommitDialog(null);
                void handleEpicCommitAndPush(dialog.epic, dialog.message);
              }}
            >
              <label className="modal-field">
                <span className="modal-field-label">
                  Commit message <span className="modal-optional">optional</span>
                </span>
                <textarea
                  className="modal-textarea"
                  value={epicCommitDialog.message}
                  onChange={(e) =>
                    setEpicCommitDialog((current) => (current ? { ...current, message: e.target.value } : current))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Leave empty and Durango Code writes one from the staged changes"
                  rows={5}
                  autoFocus
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn secondary" onClick={() => setEpicCommitDialog(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn">
                  <GitCommit size={14} />
                  {epicCommitDialog.epic.commitWithoutPush ? 'Commit' : 'Commit & push'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {epicPrBaseDialog && (
        <div className="modal-backdrop" role="presentation" onClick={() => setEpicPrBaseDialog(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="epic-pr-base-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="epic-pr-base-title" className="modal-title">
              Create pull request
            </h2>
            <p className="modal-subtitle">
              Choose the branch the pull request merges into, and optionally write it yourself.
            </p>
            <form
              className="modal-form"
              onSubmit={(e) => {
                e.preventDefault();
                const dialog = epicPrBaseDialog;
                if (dialog.branchesLoading || !dialog.baseBranch || !dialog.branches.includes(dialog.baseBranch)) {
                  return;
                }
                setEpicPrBaseDialog(null);
                void handleEpicCreatePr(dialog.epic, dialog.baseBranch, dialog.message);
              }}
            >
              <div className="modal-field">
                <span className="modal-field-label">Base branch</span>
                <div className="relative" ref={epicPrBaseBranchPickerRef}>
                  <button
                    type="button"
                    className="modal-input flex w-full cursor-pointer items-center justify-between gap-2 text-left"
                    onClick={() => setEpicPrBaseBranchPickerOpen((open) => !open)}
                    aria-haspopup="listbox"
                    aria-expanded={epicPrBaseBranchPickerOpen}
                  >
                    <span className="truncate">
                      {!epicPrBaseDialog.baseBranch
                        ? epicPrBaseDialog.branchesLoading
                          ? 'Finding the base branch…'
                          : 'No base branch found'
                        : epicPrBaseDialog.baseBranch === epicPrBaseDialog.sourceBranch
                          ? `${epicPrBaseDialog.baseBranch} (your current branch)`
                          : epicPrBaseDialog.baseBranch === epicPrBaseDialog.defaultBranch
                            ? `${epicPrBaseDialog.baseBranch} (default)`
                            : epicPrBaseDialog.baseBranch}
                    </span>
                    <ChevronDown
                      size={14}
                      className={`shrink-0 text-[var(--text-muted)] transition-transform ${
                        epicPrBaseBranchPickerOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {epicPrBaseBranchPickerOpen && (
                    <div
                      role="listbox"
                      aria-label="Base branch"
                      className="absolute left-0 right-0 top-[calc(100%+4px)] z-[100] max-h-60 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-lg)]"
                    >
                      {/* Origin is still being asked; the picker fills itself
                                without the user having to close and reopen it. */}
                      {epicPrBaseDialog.branchesLoading && (
                        <div className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-[var(--text-muted)]">
                          <LoaderCircle size={13} className="spinning shrink-0" />
                          Loading branches on origin…
                        </div>
                      )}
                      {!epicPrBaseDialog.branchesLoading && epicPrBaseDialog.branches.length === 0 && (
                        <div className="px-2.5 py-1.5 text-[13px] text-[var(--text-muted)]">
                          {epicPrBaseDialog.branchesError || 'No branches found on origin'}
                        </div>
                      )}
                      {epicPrBaseDialog.branches.map((name) => {
                        const selected = name === epicPrBaseDialog.baseBranch;
                        const label =
                          name === epicPrBaseDialog.sourceBranch
                            ? `${name} (your current branch)`
                            : name === epicPrBaseDialog.defaultBranch
                              ? `${name} (default)`
                              : name;
                        return (
                          <button
                            key={name}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border-0 px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                              selected
                                ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                                : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                            }`}
                            onClick={() => {
                              setEpicPrBaseDialog((current) => (current ? { ...current, baseBranch: name } : current));
                              setEpicPrBaseBranchPickerOpen(false);
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate">{label}</span>
                            {selected && <Check size={13} className="shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {/* A provisional local base is never submitted. Origin must
                          confirm the branch before the PR action is enabled. */}
                {epicPrBaseDialog.branchesError && (
                  <span className="text-[12px] text-[var(--text-muted)]">{epicPrBaseDialog.branchesError}</span>
                )}
              </div>
              <label className="modal-field">
                <span className="modal-field-label">
                  Title and description <span className="modal-optional">optional</span>
                </span>
                <textarea
                  className="modal-textarea"
                  value={epicPrBaseDialog.message}
                  onChange={(e) =>
                    setEpicPrBaseDialog((current) => (current ? { ...current, message: e.target.value } : current))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Leave empty and Durango Code writes them from the branch changes. Otherwise: first line is the title, the rest is the description."
                  rows={6}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn secondary" onClick={() => setEpicPrBaseDialog(null)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn"
                  disabled={
                    epicPrBaseDialog.branchesLoading ||
                    !epicPrBaseDialog.baseBranch ||
                    !epicPrBaseDialog.branches.includes(epicPrBaseDialog.baseBranch)
                  }
                >
                  <GitPullRequest size={14} />
                  Create PR
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {epicSettleDialog && (
        <div className="modal-backdrop" role="presentation" onClick={() => setEpicSettleDialog(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="epic-settle-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="epic-settle-title" className="modal-title">
              Settle “{epicSettleDialog.epic.name}”?
            </h2>
            <p className="modal-subtitle">
              The epic moves to the archive. Its threads stay in Recent agents and their projects.
            </p>
            {epicSettleDialog.warnings.length > 0 && (
              <div className="epic-settle-warnings">
                {epicSettleDialog.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            )}
            {epicSettleDialog.canReleaseRift && (
              <label className="storage-sweep-option">
                <input
                  type="checkbox"
                  checked={epicSettleDialog.releaseRift}
                  onChange={(e) =>
                    setEpicSettleDialog((current) =>
                      current ? { ...current, releaseRift: e.target.checked } : current
                    )
                  }
                />
                <span>
                  Also free its rift workspace to reclaim disk. The branch and pull request are kept, and restoring the
                  epic recreates the rift.
                </span>
              </label>
            )}
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={() => setEpicSettleDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => confirmEpicSettlement(epicSettleDialog.epic, epicSettleDialog.releaseRift)}
              >
                <Archive size={14} />
                Settle epic
              </button>
            </div>
          </div>
        </div>
      )}

      {riftSweepDialog && (
        <div className="modal-backdrop" role="presentation" onClick={dismissRiftSweepDialog}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rift-sweep-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="rift-sweep-title" className="modal-title">
              {riftSweepDialog.entries.length === 0
                ? "Empty Rift's trash?"
                : riftSweepDialog.entries.length === 1
                  ? `Free “${riftSweepDialog.entries[0].epicName || riftSweepDialog.entries[0].name}”?`
                  : `Free ${riftSweepDialog.entries.length} rift workspaces?`}
            </h2>
            <p className="modal-subtitle">
              {riftSweepDialog.entries.length === 0
                ? "This permanently empties Rift's trash across every repository on this machine."
                : 'This removes the workspace. Epics keep their branches, commits, and pull requests, and restoring an epic recreates its rift from the source repository.'}
            </p>
            {riftSweepDialog.entries.length > 0 && (
              <div className="storage-sweep-list">
                {riftSweepDialog.entries.map((entry) => (
                  <div key={entry.riftPath} className="storage-sweep-item">
                    <span className="truncate" title={entry.riftPath}>
                      {entry.epicName || entry.name}
                    </span>
                    <span className="storage-rift-size">{formatBytes(entry.bytes)}</span>
                  </div>
                ))}
              </div>
            )}
            {riftSweepDialog.entries.some((entry) => entry.hasUncommittedChanges || entry.hasUnpushedCommits) && (
              <div className="epic-settle-warnings">
                <p>
                  {riftSweepDialog.entries.length === 1
                    ? 'This rift contains uncommitted or unpushed work. Confirming will delete that unpublished work without creating a commit or pull request.'
                    : 'Some of these rifts contain uncommitted or unpushed work. Confirming will delete that unpublished work without creating commits or pull requests.'}
                </p>
              </div>
            )}
            {riftSweepDialog.entries.some((entry) => entry.status === 'active') && (
              <div className="epic-settle-warnings">
                <p>
                  This includes an active epic’s rift. Its agents must be stopped first, and the epic cannot run agents
                  again until it is settled and restored to recreate the workspace.
                </p>
              </div>
            )}
            {riftSweepDialog.entries.some((entry) => !entry.hasMarker) && (
              <div className="epic-settle-warnings">
                <p>
                  This includes an incomplete workspace without Rift metadata. It will move to the system Trash rather
                  than Rift’s trash.
                </p>
              </div>
            )}
            {riftSweepDialog.entries.length > 0 && (
              <label className="storage-sweep-option">
                <input
                  type="checkbox"
                  checked={riftSweepDialog.runGc}
                  onChange={(e) =>
                    setRiftSweepDialog((current) => (current ? { ...current, runGc: e.target.checked } : current))
                  }
                />
                <span>
                  Empty Rift's trash afterwards. Without this the space is not actually reclaimed — but emptying it is
                  permanent and covers every repository on this machine, not just Durango Code's.
                </span>
              </label>
            )}
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={dismissRiftSweepDialog}>
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  const { entries, runGc, forcePaths, manualPaths, manualScanId } = riftSweepDialog;
                  dismissRiftSweepDialog();
                  void releaseRiftStorage(entries, { runGc, forcePaths, manualPaths, manualScanId });
                }}
              >
                <Trash2 size={14} />
                {riftSweepDialog.entries.length === 0
                  ? 'Empty trash'
                  : `Free ${riftSweepDialog.entries.length === 1 ? 'rift' : 'rifts'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {createEpicOpen && (
        <div className="modal-backdrop" role="presentation" onClick={closeCreateEpicModal}>
          <div
            className="modal create-epic-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-epic-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="create-epic-title" className="modal-title">
              New epic
            </h2>
            <p className="modal-subtitle">Group threads around a big-ticket task.</p>
            <form
              className="modal-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleCreateEpic();
              }}
            >
              <label className="modal-field">
                <span className="modal-field-label">
                  Title <span className="modal-required">*</span>
                </span>
                <input
                  ref={createEpicTitleRef}
                  type="text"
                  className="modal-input"
                  value={newEpicName}
                  onChange={(e) => setNewEpicName(e.target.value)}
                  placeholder="e.g. Optimize memory usage"
                  autoComplete="off"
                />
              </label>
              <label className="modal-field">
                <span className="modal-field-label">
                  Description <span className="modal-optional">optional</span>
                </span>
                <textarea
                  className="modal-textarea"
                  value={newEpicDescription}
                  onChange={(e) => setNewEpicDescription(e.target.value)}
                  placeholder="What does this epic cover?"
                  rows={4}
                />
              </label>
              {projects.length > 0 && (
                <div className="modal-field" ref={createEpicProjectPickerRef}>
                  <span className="modal-field-label">Projects</span>
                  <div className="flex flex-col gap-2">
                    {newEpicProjectIds.map((projectId, index) => {
                      const selectedProject = projects.find((project) => project.id === projectId) ?? null;
                      const pickerOpen = createEpicProjectPickerIndex === index;
                      const branchState = newEpicRiftBranches[projectId];
                      const branchPickerOpen = createEpicRiftBranchPickerOpen === index;
                      const selectedBranch = Object.prototype.hasOwnProperty.call(newEpicRiftBaseBranches, projectId)
                        ? newEpicRiftBaseBranches[projectId]
                        : branchState?.currentBranch ?? null;
                      return (
                        <div className="flex flex-col gap-1.5" key={`${index}-${projectId}`}>
                          <div className="relative flex items-center gap-2">
                            <button
                              type="button"
                              className="modal-input flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 text-left"
                              onClick={() => {
                                setCreateEpicRiftBranchPickerOpen(null);
                                setCreateEpicProjectPickerIndex((openIndex) => openIndex === index ? null : index);
                              }}
                              aria-haspopup="listbox"
                              aria-expanded={pickerOpen}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                {selectedProject ? (
                                  <>
                                    <ProjectIcon projectPath={selectedProject.path} size={13} />
                                    <span className="truncate">{selectedProject.name}</span>
                                  </>
                                ) : (
                                  <span className="truncate text-[var(--text-muted)]">Select project…</span>
                                )}
                              </span>
                              <ChevronDown
                                size={14}
                                className={`shrink-0 text-[var(--text-muted)] transition-transform ${
                                  pickerOpen ? 'rotate-180' : ''
                                }`}
                              />
                            </button>
                            {(newEpicProjectIds.length > 1 || !newEpicCreateRift) && (
                              <button
                                type="button"
                                className="btn icon-btn shrink-0"
                                aria-label={`Remove project ${index + 1}`}
                                title="Remove project"
                                onClick={() => {
                                  setNewEpicProjectIds((ids) => ids.filter((_, candidateIndex) => candidateIndex !== index));
                                  setCreateEpicProjectPickerIndex(null);
                                  setCreateEpicRiftBranchPickerOpen(null);
                                }}
                              >
                                <X size={14} />
                              </button>
                            )}
                            {pickerOpen && (
                              <div
                                role="listbox"
                                aria-label="Project"
                                className="absolute left-0 right-0 top-[calc(100%+4px)] z-[100] max-h-60 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-lg)]"
                              >
                                {projects.map((project) => {
                                  const selected = project.id === projectId;
                                  const usedElsewhere = newEpicProjectIds.some(
                                    (candidateId, candidateIndex) => candidateIndex !== index && candidateId === project.id
                                  );
                                  return (
                                    <button
                                      key={project.id}
                                      type="button"
                                      role="option"
                                      aria-selected={selected}
                                      disabled={usedElsewhere}
                                      title={project.path}
                                      className={`flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border-0 px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                                        selected
                                          ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                                          : usedElsewhere
                                            ? 'cursor-not-allowed bg-transparent text-[var(--text-muted)] opacity-50'
                                            : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                                      }`}
                                      onClick={() => {
                                        if (usedElsewhere) return;
                                        setNewEpicProjectIds((ids) => ids.map((id, candidateIndex) => candidateIndex === index ? project.id : id));
                                        setCreateEpicProjectPickerIndex(null);
                                      }}
                                    >
                                      <ProjectIcon projectPath={project.path} size={13} />
                                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                                      {selected && <Check size={13} className="shrink-0" />}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                          {riftsActive && newEpicCreateRift && branchState && branchState.branches.length > 0 && (
                            <div className="relative ml-5">
                              <button
                                type="button"
                                className="flex w-full cursor-pointer items-center justify-between gap-2 border-0 bg-transparent px-1 py-0.5 text-left text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                                onClick={() => {
                                  setCreateEpicProjectPickerIndex(null);
                                  setCreateEpicRiftBranchPickerOpen((openIndex) => openIndex === index ? null : index);
                                }}
                                aria-haspopup="listbox"
                                aria-expanded={branchPickerOpen}
                              >
                                <span className="truncate">
                                  Branch from: {selectedBranch
                                    ? selectedBranch === branchState.currentBranch
                                      ? `${selectedBranch} (current)`
                                      : selectedBranch
                                    : 'current commit (detached HEAD)'}
                                </span>
                                <ChevronDown size={12} className={`shrink-0 transition-transform ${branchPickerOpen ? 'rotate-180' : ''}`} />
                              </button>
                              {branchPickerOpen && (
                                <div
                                  role="listbox"
                                  aria-label={`Rift branch from for ${selectedProject?.name ?? `project ${index + 1}`}`}
                                  className="absolute left-0 right-0 top-[calc(100%+4px)] z-[100] max-h-60 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-lg)]"
                                >
                                  {branchState.currentBranch === null && (
                                    <button
                                      type="button"
                                      role="option"
                                      aria-selected={selectedBranch === null}
                                      className={`flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border-0 px-2.5 py-1.5 text-left text-[13px] transition-colors ${selectedBranch === null ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
                                      onClick={() => {
                                        setNewEpicRiftBaseBranches((current) => ({ ...current, [projectId]: null }));
                                        setCreateEpicRiftBranchPickerOpen(null);
                                      }}
                                    >
                                      <span className="min-w-0 flex-1 truncate">Current commit (detached HEAD)</span>
                                      {selectedBranch === null && <Check size={13} className="shrink-0" />}
                                    </button>
                                  )}
                                  {branchState.branches.map((name) => {
                                    const selected = name === selectedBranch;
                                    return (
                                      <button
                                        key={name}
                                        type="button"
                                        role="option"
                                        aria-selected={selected}
                                        className={`flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border-0 px-2.5 py-1.5 text-left text-[13px] transition-colors ${selected ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
                                        onClick={() => {
                                          setNewEpicRiftBaseBranches((current) => ({ ...current, [projectId]: name }));
                                          setCreateEpicRiftBranchPickerOpen(null);
                                        }}
                                      >
                                        <span className="min-w-0 flex-1 truncate">
                                          {name === branchState.currentBranch ? `${name} (current)` : name}
                                        </span>
                                        {selected && <Check size={13} className="shrink-0" />}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {newEpicProjectIds.length < projects.length && (
                      <button
                        type="button"
                        className="btn secondary self-start"
                        onClick={() => {
                          const nextProject = projects.find((project) => !newEpicProjectIds.includes(project.id));
                          if (!nextProject) return;
                          setNewEpicProjectIds((ids) => [...ids, nextProject.id]);
                          setCreateEpicProjectPickerIndex(newEpicProjectIds.length);
                        }}
                      >
                        <Plus size={14} />
                        Add another project
                      </button>
                    )}
                  </div>
                </div>
              )}
              {riftsActive && (
                <label className="modal-field modal-field-checkbox">
                  <span className="modal-field-label">Rift</span>
                  <span className="modal-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newEpicCreateRift}
                      onChange={(e) => setNewEpicCreateRift(e.target.checked)}
                    />
                    <span className="modal-checkbox-text">
                      Work in a rift — copy all selected projects into one shared workspace, each on its own branch
                    </span>
                  </span>
                </label>
              )}
              <div className="modal-actions">
                <button type="button" className="btn secondary" onClick={closeCreateEpicModal}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn"
                  disabled={!newEpicName.trim() || (newEpicCreateRift && newEpicProjectIds.length === 0)}
                >
                  Create epic
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
});

export default AppDialogs;
