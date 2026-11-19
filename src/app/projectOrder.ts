/**
 * Project lists (sidebar, project picker, Sidebar v3's Projects window) put
 * the project where a thread was most recently started first: each project's
 * key is the newest `createdAt` among its threads, whoever started them (you,
 * a bot, a subagent). Last message or last opened don't count, so replying in
 * an old thread or just selecting a project doesn't reorder the list.
 *
 * Projects with no threads go last, in store order: `addProject` puts new
 * projects first, so that is newest added first (imported projects follow).
 * Equal start times fall back to the name, then store order, so the list
 * never jitters.
 */
export const sortProjectsByLatestThreadStart = <P extends { id: string; name: string }>(
  projects: readonly P[],
  threads: ReadonlyArray<{ projectId: string; createdAt: string }>
): P[] => {
  const latestStart = new Map<string, number>();
  for (const thread of threads) {
    const startedAt = Date.parse(thread.createdAt);
    if (!Number.isFinite(startedAt)) continue;
    if (startedAt > (latestStart.get(thread.projectId) ?? -Infinity)) latestStart.set(thread.projectId, startedAt);
  }
  return projects
    .map((project, index) => ({ project, index, startedAt: latestStart.get(project.id) }))
    .sort((a, b) => {
      if (a.startedAt === undefined || b.startedAt === undefined) {
        if (a.startedAt !== b.startedAt) return a.startedAt === undefined ? 1 : -1;
        return a.index - b.index;
      }
      return b.startedAt - a.startedAt || a.project.name.localeCompare(b.project.name) || a.index - b.index;
    })
    .map((entry) => entry.project);
};
