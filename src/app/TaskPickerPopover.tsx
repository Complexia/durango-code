import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, LogIn, RefreshCw, Search, SquareKanban } from 'lucide-react';

export const TaskPickerPopover = ({
  linkedTaskIds,
  authenticated,
  onSignIn,
  onPick,
}: {
  /** Ids of the tasks already linked to this thread — picking one again unlinks it. */
  linkedTaskIds: string[];
  authenticated: boolean;
  onSignIn: () => void;
  onPick: (task: OrionBoardTask) => Promise<void> | void;
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(!authenticated);
  const [columns, setColumns] = useState<OrionBoardColumn[]>([]);
  const [tasks, setTasks] = useState<OrionBoardTask[]>([]);
  const [search, setSearch] = useState('');
  const [linkingId, setLinkingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!window.orion?.listBoardTasks) {
      setError('Durango Tasks are unavailable in this build.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const result = await window.orion.listBoardTasks();
    if (result.ok) {
      setColumns(result.columns ?? []);
      setTasks(result.tasks ?? []);
      setNeedsAuth(false);
    } else if (result.needsAuth) {
      setNeedsAuth(true);
    } else {
      setError(result.error ?? 'Could not load your Durango Tasks.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const query = search.trim().toLowerCase();
  const visibleTasks = query
    ? tasks.filter(
        (task) =>
          task.title.toLowerCase().includes(query) ||
          task.description.toLowerCase().includes(query)
      )
    : tasks;

  return (
    <div className="task-picker-popover">
      <div className="task-picker-header">
        <SquareKanban size={14} />
        <span>
          {linkedTaskIds.length > 0
            ? `Durango Tasks · ${linkedTaskIds.length} linked`
            : 'Link Durango Tasks'}
        </span>
        {window.orion?.openBoardTasksWeb && (
          <button
            className="task-picker-refresh"
            onClick={() => void window.orion.openBoardTasksWeb?.()}
            title="Open in Durango"
          >
            <ExternalLink size={13} />
          </button>
        )}
        <button className="task-picker-refresh" onClick={() => void load()} title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>
      {needsAuth ? (
        <div className="task-picker-empty">
          <p>Sign in to your Durango account to link tasks from Durango Tasks.</p>
          <button className="task-picker-signin" onClick={onSignIn}>
            <LogIn size={14} />
            <span>Sign in to Durango</span>
          </button>
        </div>
      ) : (
        <>
          <div className="task-picker-search">
            <Search size={14} />
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tasks..."
            />
          </div>
          <div className="task-picker-list">
            {loading && <div className="task-picker-note">Loading your tasks…</div>}
            {!loading && error && <div className="task-picker-note error">{error}</div>}
            {!loading && !error && visibleTasks.length === 0 && (
              <div className="task-picker-note">
                {tasks.length === 0 ? (
                  <>
                    No tasks yet — create them in Durango Chat or at{' '}
                    <button
                      type="button"
                      className="task-picker-inline-link"
                      onClick={() => void window.orion?.openBoardTasksWeb?.()}
                    >
                      Durango Tasks
                    </button>
                    .
                  </>
                ) : (
                  'No tasks match your search.'
                )}
              </div>
            )}
            {!loading &&
              !error &&
              columns.map((column) => {
                const columnTasks = visibleTasks.filter((task) => task.columnId === column.id);
                if (columnTasks.length === 0) return null;
                return (
                  <div key={column.id} className="task-picker-group">
                    <div className="task-picker-column-label">{column.name}</div>
                    {columnTasks.map((task) => {
                      // Threads linked before the switch hold the old board id.
                      const isCurrent =
                        linkedTaskIds.includes(task.id) ||
                        (task.legacyId != null && linkedTaskIds.includes(task.legacyId));
                      const linkedElsewhere = Boolean(task.linked) && !isCurrent;
                      return (
                        <button
                          key={task.id}
                          className={`task-picker-row ${isCurrent ? 'selected' : ''}`}
                          disabled={linkingId !== null}
                          onClick={async () => {
                            setLinkingId(task.id);
                            try {
                              await onPick(task);
                            } finally {
                              setLinkingId(null);
                            }
                          }}
                          title={
                            isCurrent
                              ? 'Linked — click to unlink'
                              : task.description || task.title
                          }
                        >
                          <span className="task-picker-row-title">{task.title}</span>
                          {isCurrent && <Check size={14} />}
                          {linkedElsewhere && <span className="task-picker-tag">linked</span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
          </div>
          <div className="task-picker-footer">
            Pick as many tasks as you like — each one's title, description, and attachments are
            added to the agent's context, and its status in Durango Tasks follows this thread.
            Click a linked task to unlink it.{' '}
            <button
              type="button"
              className="task-picker-inline-link"
              onClick={() => void window.orion?.openBoardTasksWeb?.()}
            >
              Open in Durango
            </button>
          </div>
        </>
      )}
    </div>
  );
};
