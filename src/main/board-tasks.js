import fs from 'node:fs/promises';
import path from 'node:path';
import { DurangoError } from './durango-client.js';

// Linked tasks for the composer's task picker (`tasks:*` IPC). Durango Tasks
// (durango.sh/tasks, `/api/v1/tasks*` with the device's Durango key,
// contracts §7) replaced the Durango Code web board (`/api/tasks*` on the
// same origin, with the desktop session). The legacy path stays for
// rollback: `DURANGO_TASKS=0` (or the Settings toggle) switches back.
//
// Both paths return the same IPC shapes, so the renderer (TaskPickerPopover,
// Thread.linkedTasks, buildLinkedTaskContext) is unchanged:
// - list → { ok, columns, tasks } | { ok:false, error, needsAuth? }
// - get/link/unlink/threadStatus → { ok, task } | { ok:false, error, stale?, needsAuth? }
// `stale` tells the renderer to drop its side of the link: the task is gone
// (404 on get) or was unlinked/relinked elsewhere (409).
//
// Threads linked before the switch keep their old board task ids. Durango
// resolves those legacy ids on GET/POST /api/v1/tasks/:id (contracts §5), so
// status pushes keep moving the migrated card without a re-link.

/** Durango Tasks unless `DURANGO_TASKS=0` or the user switched back in Settings. */
export const durangoTasksEnabled = ({ env = process.env, setting } = {}) =>
  String(env?.DURANGO_TASKS ?? '').trim() !== '0' && setting !== false;

const SIGN_IN_TO_LIST = 'Sign in to your Durango account to see your tasks.';
const SIGN_IN = 'Sign in to your Durango account first.';

export const createBoardTasks = ({
  useDurango = () => true,
  durango,
  readToken,
  webOrigin,
  fetchImpl = fetch,
  attachmentDir,
  sanitizeName = (name) => String(name ?? '').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'attachment',
  legacyErrorMessage = (error) => error?.message ?? String(error),
}) => {
  // --- Durango Tasks ---------------------------------------------------------------

  const durangoFailure = (error, { stale = false } = {}) => {
    if (error instanceof DurangoError && error.code === 'not_signed_in') {
      return { ok: false, error: error.message || SIGN_IN, needsAuth: true };
    }
    const message = error instanceof DurangoError ? error.message : error?.message ?? String(error);
    return { ok: false, ...(stale ? { stale: true } : {}), error: message };
  };

  const isStatus = (error, status) => error instanceof DurangoError && error.status === status;

  // Same local layout as the legacy board (`attachments/board-<task>-<id>-<name>`),
  // so injected task context reads the same either way.
  const downloadAttachments = async (task, download) => {
    const attachments = Array.isArray(task?.attachments) ? task.attachments : [];
    if (attachments.length === 0) return { ...task, attachments: [] };
    const directory = attachmentDir();
    await fs.mkdir(directory, { recursive: true });
    const downloaded = await Promise.all(
      attachments.map(async (attachment) => {
        const attachmentId = String(attachment?.id ?? '');
        const taskId = String(task?.id ?? '');
        if (!attachmentId || !taskId) return { ...attachment, downloadError: 'Invalid attachment metadata.' };
        const originalName = sanitizeName(attachment?.fileName || attachment?.name || 'attachment');
        const filePath = path.join(
          directory,
          `board-${sanitizeName(taskId)}-${sanitizeName(attachmentId)}-${originalName}`
        );
        try {
          const expectedSize = Number(attachment?.size);
          const existing = await fs.stat(filePath).catch(() => null);
          if (!existing?.isFile() || (Number.isFinite(expectedSize) && existing.size !== expectedSize)) {
            const buffer = await download(taskId, attachment);
            if (Number.isFinite(expectedSize) && expectedSize >= 0 && buffer.byteLength !== expectedSize) {
              throw new Error('Attachment download was incomplete.');
            }
            await fs.writeFile(filePath, buffer);
          }
          // The presigned URL is short-lived and must not end up in thread state.
          const { url: _url, apiUrl: _apiUrl, ...rest } = attachment;
          return { ...rest, fileName: attachment?.fileName || attachment?.name || originalName, localPath: filePath };
        } catch (error) {
          const { url: _url, apiUrl: _apiUrl, ...rest } = attachment;
          return {
            ...rest,
            fileName: attachment?.fileName || attachment?.name || originalName,
            downloadError: error instanceof DurangoError ? error.message : legacyErrorMessage(error),
          };
        }
      })
    );
    return { ...task, attachments: downloaded };
  };

  const durangoDownload = (taskId, attachment) => durango.downloadTaskAttachment(taskId, attachment);

  const durangoTasks = {
    async list() {
      try {
        const board = await durango.listTasks();
        return { ok: true, columns: board.columns ?? [], tasks: board.tasks ?? [] };
      } catch (error) {
        if (error instanceof DurangoError && error.code === 'not_signed_in') {
          return { ok: false, error: SIGN_IN_TO_LIST, needsAuth: true };
        }
        return durangoFailure(error);
      }
    },
    async get(taskId) {
      try {
        const { task } = await durango.getTask(taskId);
        if (!task) return { ok: false, stale: true, error: 'Task not found.' };
        return { ok: true, task: await downloadAttachments(task, durangoDownload) };
      } catch (error) {
        return durangoFailure(error, { stale: isStatus(error, 404) });
      }
    },
    async link({ taskId, threadId, threadTitle, projectName }) {
      try {
        const { task } = await durango.taskAction(taskId, {
          action: 'link',
          threadId,
          ...(typeof threadTitle === 'string' ? { threadTitle } : {}),
          ...(typeof projectName === 'string' ? { projectName } : {}),
        });
        return { ok: true, task: await downloadAttachments(task, durangoDownload) };
      } catch (error) {
        return durangoFailure(error);
      }
    },
    async unlink({ taskId, threadId }) {
      try {
        // With threadId Durango refuses (409) to unlink a card that another
        // thread has linked since; the renderer then just drops its side.
        const { task } = await durango.taskAction(taskId, {
          action: 'unlink',
          ...(threadId ? { threadId } : {}),
        });
        return { ok: true, task };
      } catch (error) {
        return durangoFailure(error, { stale: isStatus(error, 409) || isStatus(error, 404) });
      }
    },
    async threadStatus({ taskId, threadId, status, notes }) {
      try {
        const { task } = await durango.taskAction(taskId, {
          action: 'thread-status',
          threadId,
          status,
          ...(typeof notes === 'string' ? { agentNotes: notes } : {}),
        });
        return { ok: true, task };
      } catch (error) {
        // 409 = the card was unlinked/relinked on Durango; 404 = deleted.
        return durangoFailure(error, { stale: isStatus(error, 409) || isStatus(error, 404) });
      }
    },
  };

  // --- Legacy Durango Code web board (/api/tasks*) ---------------------------------

  const legacyRequest = async (token, apiPath, options = {}) => {
    const response = await fetchImpl(new URL(apiPath, webOrigin()), {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      // non-JSON error body
    }
    if (!response.ok) {
      const error = new Error(data?.error || `Durango Cloud request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  };

  const legacyDownload = (token) => async (taskId, attachment) => {
    const response = await fetchImpl(
      new URL(
        `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(String(attachment?.id ?? ''))}`,
        webOrigin()
      ),
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (!response.ok) throw new Error(`Attachment download failed (${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  };

  const withToken = async (signInMessage, operation) => {
    const token = await readToken();
    if (!token) return { ok: false, error: signInMessage, needsAuth: true };
    return operation(token);
  };

  const legacyTasks = {
    list: () =>
      withToken(SIGN_IN_TO_LIST, async (token) => {
        try {
          const board = await legacyRequest(token, '/api/tasks');
          return { ok: true, columns: board.columns ?? [], tasks: board.tasks ?? [] };
        } catch (error) {
          return { ok: false, error: legacyErrorMessage(error) };
        }
      }),
    get: (taskId) =>
      withToken(SIGN_IN, async (token) => {
        try {
          const result = await legacyRequest(token, `/api/tasks/${encodeURIComponent(taskId)}`);
          return { ok: true, task: await downloadAttachments(result.task, legacyDownload(token)) };
        } catch (error) {
          if (error?.status === 404) return { ok: false, stale: true, error: legacyErrorMessage(error) };
          return { ok: false, error: legacyErrorMessage(error) };
        }
      }),
    link: ({ taskId, threadId, threadTitle, projectName }) =>
      withToken(SIGN_IN, async (token) => {
        try {
          const result = await legacyRequest(token, `/api/tasks/${encodeURIComponent(taskId)}`, {
            method: 'POST',
            body: JSON.stringify({ action: 'link', threadId, threadTitle, projectName }),
          });
          return { ok: true, task: await downloadAttachments(result.task, legacyDownload(token)) };
        } catch (error) {
          return { ok: false, error: legacyErrorMessage(error) };
        }
      }),
    unlink: ({ taskId }) =>
      withToken(SIGN_IN, async (token) => {
        try {
          const result = await legacyRequest(token, `/api/tasks/${encodeURIComponent(taskId)}`, {
            method: 'POST',
            body: JSON.stringify({ action: 'unlink' }),
          });
          return { ok: true, task: result.task };
        } catch (error) {
          return { ok: false, error: legacyErrorMessage(error) };
        }
      }),
    threadStatus: ({ taskId, threadId, status, notes }) =>
      withToken(SIGN_IN, async (token) => {
        try {
          const result = await legacyRequest(token, `/api/tasks/${encodeURIComponent(taskId)}`, {
            method: 'POST',
            body: JSON.stringify({
              action: 'thread-status',
              threadId,
              status,
              ...(typeof notes === 'string' ? { notes } : {}),
            }),
          });
          return { ok: true, task: result.task };
        } catch (error) {
          // 409 = the card was unlinked/relinked on the web; tell the renderer to
          // drop its side of the link instead of retrying forever.
          if (error?.status === 409) return { ok: false, stale: true, error: legacyErrorMessage(error) };
          return { ok: false, error: legacyErrorMessage(error) };
        }
      }),
  };

  const backend = () => (useDurango() ? durangoTasks : legacyTasks);
  const text = (value) => String(value ?? '');

  return {
    list: () => backend().list(),
    get(rawTaskId) {
      const taskId = text(rawTaskId);
      if (!taskId) return Promise.resolve({ ok: false, error: 'Missing task id.' });
      return backend().get(taskId);
    },
    link(input) {
      const taskId = text(input?.taskId);
      const threadId = text(input?.threadId);
      if (!taskId || !threadId) return Promise.resolve({ ok: false, error: 'Missing task or thread id.' });
      return backend().link({ taskId, threadId, threadTitle: input?.threadTitle, projectName: input?.projectName });
    },
    unlink(input) {
      const taskId = text(input?.taskId);
      if (!taskId) return Promise.resolve({ ok: false, error: 'Missing task id.' });
      return backend().unlink({ taskId, threadId: text(input?.threadId) });
    },
    threadStatus(input) {
      const taskId = text(input?.taskId);
      const threadId = text(input?.threadId);
      const status = text(input?.status);
      if (!taskId || !threadId || !status) return Promise.resolve({ ok: false, error: 'Missing task status input.' });
      return backend().threadStatus({
        taskId,
        threadId,
        status,
        notes: typeof input?.notes === 'string' ? input.notes : undefined,
      });
    },
    /** Where "Open in Durango" goes: Durango Tasks, or the legacy web board. */
    async webUrl() {
      if (useDurango()) return new URL('/tasks', await durango.baseUrl()).toString();
      return new URL('/board', webOrigin()).toString();
    },
  };
};
