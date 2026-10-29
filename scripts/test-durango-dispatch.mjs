// Durango Tasks switch (src/main/board-tasks.js), the Durango client's tasks
// and dispatch methods (src/main/durango-client.js) and the Durango Chat
// dispatch worker (src/main/durango-dispatch.js), against a fake Durango
// server on localhost. Also the renderer's dispatch outcome helper.
//
//   node --no-warnings --experimental-strip-types scripts/test-durango-dispatch.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DurangoError, createDurangoClient } from '../src/main/durango-client.js';
import { createBoardTasks, durangoTasksEnabled } from '../src/main/board-tasks.js';
import {
  DISPATCH_SUMMARY_MAX_CHARS,
  buildDispatchPrompt,
  buildMachinePayload,
  clampDispatchAccessMode,
  createDispatchWorker,
  normalizeDispatchSettings,
  resolveDispatchProject,
} from '../src/main/durango-dispatch.js';
import { durangoDispatchOutcome, dispatchSummaryText } from '../src/app/durangoDispatch.ts';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-durango-dispatch-'));

// --- Fake Durango (and legacy Durango Code web) server -------------------------------

const createFakeServer = () => {
  const requests = [];
  const handlers = new Map(); // "METHOD /path" -> queue of (req, body, url) => { status, json?, body?, headers? }
  const fallbacks = new Map(); // "METHOD /path" -> handler used when the queue is empty
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? null, body });
    const queue = handlers.get(key);
    const handler = queue?.length ? queue.shift() : fallbacks.get(key);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no handler for ${key}`, type: 'invalid_request_error', code: 'not_found' } }));
      return;
    }
    const result = await handler(req, body, url);
    res.writeHead(result.status ?? 200, { ...(result.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(result.headers ?? {}) });
    res.end(result.json !== undefined ? JSON.stringify(result.json) : result.body ?? '');
  });
  return {
    requests,
    on(method, pathname, ...queued) {
      const key = `${method} ${pathname}`;
      handlers.set(key, [...(handlers.get(key) ?? []), ...queued]);
    },
    always(method, pathname, handler) {
      fallbacks.set(`${method} ${pathname}`, handler);
    },
    reset() {
      requests.length = 0;
      handlers.clear();
      fallbacks.clear();
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const durangoErrorBody = (message, code) => ({ error: { message, type: 'invalid_request_error', code } });

const server = createFakeServer();
const base = await server.listen();

const session = { value: { token: 'desktop-session', user: { id: 'user_1' } } };
const credentials = {
  async get() {
    return { key: 'dgo_test', keyId: 'key_1', baseUrl: base };
  },
  async refresh() {
    return { key: 'dgo_test2', keyId: 'key_2', baseUrl: base };
  },
  async peek() {
    return { key: 'dgo_test', keyId: 'key_1', baseUrl: base };
  },
};
const client = createDurangoClient({ credentials, readSession: async () => session.value, isPackaged: () => false, durangoUrlOverride: () => undefined });

const wireTask = (overrides = {}) => ({
  id: 'jd7task1',
  columnId: 'col_todo',
  title: 'Fix signup',
  description: 'Plus signs break signup.',
  position: 0,
  attachments: [],
  agentNotes: null,
  linked: null,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  status: 'todo',
  legacyId: null,
  url: 'https://durango.sh/tasks?task=jd7task1',
  ...overrides,
});

let failures = 0;
const liveWorkers = new Set();
const test = async (name, fn) => {
  server.reset();
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  } finally {
    // A failed assertion must not leave a claim loop running into the next test.
    for (const worker of liveWorkers) worker.stop();
    await Promise.all([...liveWorkers].map((worker) => worker.idle()));
    // Let aborted long-polls reach the fake server before the next test
    // resets its handlers, so they cannot consume that test's responses.
    if (liveWorkers.size > 0) await new Promise((resolve) => setTimeout(resolve, 50));
    liveWorkers.clear();
  }
};

try {
  // ======================================================================================
  // Tasks switch
  // ======================================================================================

  const attachmentDir = path.join(testRoot, 'attachments');
  const boardTasks = (options = {}) =>
    createBoardTasks({
      useDurango: () => durangoTasksEnabled({ env: options.env ?? {}, setting: options.setting }),
      durango: client,
      readToken: async () => session.value?.token ?? null,
      webOrigin: () => `${base}/`,
      attachmentDir: () => attachmentDir,
      legacyErrorMessage: (error) => error?.message ?? String(error),
    });

  await test('feature flag: DURANGO_TASKS=0 or the setting falls back to the legacy board', () => {
    assert.equal(durangoTasksEnabled({ env: {} }), true);
    assert.equal(durangoTasksEnabled({ env: { DURANGO_TASKS: '1' } }), true);
    assert.equal(durangoTasksEnabled({ env: { DURANGO_TASKS: '0' } }), false);
    assert.equal(durangoTasksEnabled({ env: { DURANGO_TASKS: ' 0 ' } }), false);
    assert.equal(durangoTasksEnabled({ env: {}, setting: false }), false);
    assert.equal(durangoTasksEnabled({ env: {}, setting: true }), true);
  });

  await test('tasks:list reads GET /api/v1/tasks with the Durango key (board-compatible shape)', async () => {
    server.on('GET', '/api/v1/tasks', () => ({
      json: { columns: [{ id: 'col_todo', name: 'To do', title: 'To do', role: 'todo', position: 0 }], tasks: [wireTask()] },
    }));
    const result = await boardTasks().list();
    assert.equal(result.ok, true);
    assert.equal(result.columns[0].name, 'To do');
    assert.equal(result.tasks[0].id, 'jd7task1');
    assert.equal(server.requests[0].auth, 'Bearer dgo_test');
  });

  await test('tasks:get accepts a legacy board id and downloads attachments to attachments/board-…', async () => {
    const bytes = Buffer.from('hello attachment');
    server.on('GET', '/api/v1/tasks/orion_legacy_1', () => ({
      json: {
        task: wireTask({
          legacyId: 'orion_legacy_1',
          attachments: [
            { id: 'att1', fileName: 'spec.txt', name: 'spec.txt', contentType: 'text/plain', size: bytes.length, createdAt: '2026-10-10T00:00:00.000Z', url: `${base}/storage/att1?sig=1`, apiUrl: `${base}/api/v1/tasks/jd7task1/attachments/att1` },
          ],
        }),
      },
    }));
    server.on('GET', '/storage/att1', (req) => {
      assert.equal(req.headers.authorization, undefined, 'the presigned URL is fetched without the Durango key');
      return { body: bytes };
    });
    const result = await boardTasks().get('orion_legacy_1');
    assert.equal(result.ok, true);
    assert.equal(result.task.id, 'jd7task1', 'Durango answers with its own id');
    const attachment = result.task.attachments[0];
    assert.equal(attachment.localPath, path.join(attachmentDir, 'board-jd7task1-att1-spec.txt'));
    assert.equal(await fs.readFile(attachment.localPath, 'utf8'), 'hello attachment');
    assert.equal(attachment.url, undefined, 'presigned URLs never reach the renderer');
    assert.equal(attachment.apiUrl, undefined);
  });

  await test('expired presigned attachment URL falls back to the API download route', async () => {
    const bytes = Buffer.from('fresh bytes');
    server.on('GET', '/api/v1/tasks/jd7task2', () => ({
      json: { task: wireTask({ id: 'jd7task2', attachments: [{ id: 'att2', fileName: 'a.png', name: 'a.png', contentType: 'image/png', size: bytes.length, createdAt: 'x', url: `${base}/storage/expired` }] }) },
    }));
    server.on('GET', '/storage/expired', () => ({ status: 403, body: 'expired' }));
    server.on('GET', '/api/v1/tasks/jd7task2/attachments/att2', (req) => {
      assert.equal(req.headers.authorization, 'Bearer dgo_test');
      return { status: 307, headers: { location: `${base}/storage/fresh` } };
    });
    server.on('GET', '/storage/fresh', () => ({ body: bytes }));
    const result = await boardTasks().get('jd7task2');
    assert.equal(result.task.attachments[0].downloadError, undefined);
    assert.equal(await fs.readFile(result.task.attachments[0].localPath, 'utf8'), 'fresh bytes');
  });

  await test('tasks:get 404 → stale; signed out → needsAuth (no request)', async () => {
    server.on('GET', '/api/v1/tasks/gone', () => ({ status: 404, json: durangoErrorBody('Task not found.', 'task_not_found') }));
    const gone = await boardTasks().get('gone');
    assert.deepEqual(gone, { ok: false, stale: true, error: 'Task not found.' });
    const saved = session.value;
    session.value = null;
    try {
      const list = await boardTasks().list();
      assert.equal(list.needsAuth, true);
      const get = await boardTasks().get('x');
      assert.equal(get.needsAuth, true);
      assert.equal(server.requests.length, 1, 'only the 404 request was made');
    } finally {
      session.value = saved;
    }
  });

  await test('tasks:link / thread-status / unlink post the contract bodies; 409 → stale', async () => {
    server.on('POST', '/api/v1/tasks/jd7task1',
      (_req, body) => {
        assert.deepEqual(body, { action: 'link', threadId: 'thread-1', threadTitle: 'Fix signup', projectName: 'futuremail' });
        return { json: { task: wireTask({ linked: { threadId: 'thread-1', threadTitle: 'Fix signup', projectName: 'futuremail', status: 'idle', linkedAt: 'x' } }) } };
      },
      (_req, body) => {
        assert.deepEqual(body, { action: 'thread-status', threadId: 'thread-1', status: 'finished', agentNotes: 'Done: fixed.' });
        return { json: { task: wireTask({ columnId: 'col_review' }) } };
      },
      () => ({ status: 409, json: durangoErrorBody('Thread is not linked to this task.', 'stale_link') }),
      (_req, body) => {
        assert.deepEqual(body, { action: 'unlink', threadId: 'thread-1' });
        return { status: 409, json: durangoErrorBody('Thread is not linked to this task.', 'stale_link') };
      }
    );
    const tasks = boardTasks();
    const linked = await tasks.link({ taskId: 'jd7task1', threadId: 'thread-1', threadTitle: 'Fix signup', projectName: 'futuremail' });
    assert.equal(linked.ok, true);
    assert.equal(linked.task.linked.threadId, 'thread-1');
    const status = await tasks.threadStatus({ taskId: 'jd7task1', threadId: 'thread-1', status: 'finished', notes: 'Done: fixed.' });
    assert.equal(status.ok, true);
    const stale = await tasks.threadStatus({ taskId: 'jd7task1', threadId: 'thread-1', status: 'running' });
    assert.deepEqual(stale, { ok: false, stale: true, error: 'Thread is not linked to this task.' }, 'reads error.message from the /api/v1 envelope');
    const unlinked = await tasks.unlink({ taskId: 'jd7task1', threadId: 'thread-1' });
    assert.equal(unlinked.stale, true, 'a 409 unlink drops the local side without an error toast');
    assert.equal(await tasks.link({ taskId: '', threadId: 'x' }).then((r) => r.error), 'Missing task or thread id.');
  });

  await test('fallback: DURANGO_TASKS=0 uses orion-next /api/tasks* with the desktop session', async () => {
    server.on('GET', '/api/tasks', (req) => {
      assert.equal(req.headers.authorization, 'Bearer desktop-session');
      return { json: { columns: [{ id: 'c', name: 'Todo', role: 'todo', position: 0 }], tasks: [] } };
    });
    server.on('POST', '/api/tasks/old1',
      (_req, body) => {
        assert.deepEqual(body, { action: 'thread-status', threadId: 't', status: 'finished', notes: 'n' }, 'legacy body keeps `notes`');
        return { status: 409, json: { error: 'Thread is not linked to this task.' } };
      },
      (_req, body) => {
        assert.deepEqual(body, { action: 'unlink' });
        return { json: { task: wireTask({ id: 'old1' }) } };
      }
    );
    const tasks = boardTasks({ env: { DURANGO_TASKS: '0' } });
    assert.equal((await tasks.list()).columns[0].name, 'Todo');
    assert.deepEqual(await tasks.threadStatus({ taskId: 'old1', threadId: 't', status: 'finished', notes: 'n' }), {
      ok: false,
      stale: true,
      error: 'Thread is not linked to this task.',
    });
    assert.equal((await tasks.unlink({ taskId: 'old1', threadId: 't' })).ok, true);
    assert.equal(await tasks.webUrl(), `${base}/board`);
    assert.equal(await boardTasks().webUrl(), `${base}/tasks`, '"Open in Durango" goes to Durango Tasks');
    assert.ok(server.requests.every((request) => !request.path.startsWith('/api/v1/')), 'no Durango calls on the legacy path');
  });

  // ======================================================================================
  // Dispatch: pure helpers
  // ======================================================================================

  const projects = [
    { id: 'p1', name: 'futuremail', path: '/code/futuremail', repoId: 'repo_fm' },
    { id: 'p2', name: 'Billing', path: '/code/billing', repoId: null },
    { id: 'p3', name: 'secret', path: '/code/secret', repoId: 'repo_secret' },
  ];

  await test('machine registration payload: stable id, name, platform, allowlisted projects with repoId|null', () => {
    const payload = buildMachinePayload({ machineId: 'dev-1', name: 'Complexia MacBook', platform: 'darwin', projects, allowedProjectIds: ['p1', 'p2'] });
    assert.deepEqual(payload, {
      machineId: 'dev-1',
      name: 'Complexia MacBook',
      platform: 'darwin',
      projects: [
        { id: 'p1', name: 'futuremail', repoId: 'repo_fm' },
        { id: 'p2', name: 'Billing', repoId: null },
      ],
    });
    assert.equal(buildMachinePayload({ machineId: 'd', name: '', platform: 'darwin', projects }).projects.length, 3, 'null allowlist = all projects');
    assert.equal(buildMachinePayload({ machineId: 'd', name: '  ', platform: '', projects: [] }).name, 'Mac');
  });

  await test('project resolution: repoId, then id, then name; unknown and not-allowlisted fail clearly', () => {
    assert.equal(resolveDispatchProject({ project: { repoId: 'repo_fm', name: 'other' } }, projects).project.id, 'p1');
    assert.equal(resolveDispatchProject({ project: { id: 'p2' } }, projects).project.id, 'p2');
    assert.equal(resolveDispatchProject({ project: { name: 'BILLING' } }, projects).project.id, 'p2', 'case-insensitive name');
    assert.equal(resolveDispatchProject({ project: { repoId: 'repo_unknown', name: 'futuremail' } }, projects).project.id, 'p1', 'repo miss falls back to name');
    const missing = resolveDispatchProject({ project: { name: 'nope' } }, projects);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no project matching "nope"/);
    const blocked = resolveDispatchProject({ project: { repoId: 'repo_secret' } }, projects, ['p1']);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /"secret" is not allowed to run agents from Durango on this Mac/);
    const none = resolveDispatchProject({ project: { id: null, name: null, repoId: null } }, projects);
    assert.equal(none.ok, false);
    assert.match(none.error, /did not say which project/);
  });

  await test('access mode never exceeds the configured ceiling', () => {
    assert.equal(clampDispatchAccessMode('ask', 'full-access'), 'read-only');
    assert.equal(clampDispatchAccessMode('auto-edit', 'read-only'), 'read-only');
    assert.equal(clampDispatchAccessMode('auto-edit', 'workspace-write'), 'workspace-write');
    assert.equal(clampDispatchAccessMode('auto-edit', 'full-access'), 'workspace-write', 'chat cannot ask for full access');
    assert.equal(clampDispatchAccessMode(null, 'workspace-write'), 'workspace-write');
    assert.equal(clampDispatchAccessMode(null, 'bogus'), 'read-only');
    assert.equal(normalizeDispatchSettings({}).accessMode, 'read-only', 'default is the most conservative mode');
    assert.equal(normalizeDispatchSettings({}).enabled, false, 'off by default');
    assert.equal(normalizeDispatchSettings({ maxConcurrent: 5 }).maxConcurrent, 1);
  });

  await test('dispatch prompt carries the Durango Chat provenance header', () => {
    assert.equal(
      buildDispatchPrompt({ prompt: ' fix it ', sourceChat: { url: 'https://durango.sh/c/abc' } }),
      '[Started from Durango Chat: https://durango.sh/c/abc]\n\nfix it'
    );
    assert.equal(buildDispatchPrompt({ prompt: 'x', sourceChat: null }), '[Started from Durango Chat]\n\nx');
    assert.equal(
      buildDispatchPrompt({ origin: 'tasks', prompt: 'Work on it', taskUrl: 'https://durango.sh/tasks?task=t1', sourceChat: null }),
      '[Started from Durango Tasks: https://durango.sh/tasks?task=t1]\n\nWork on it'
    );
  });

  // ======================================================================================
  // Dispatch worker against the fake server
  // ======================================================================================

  const nextTick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const waitUntil = async (predicate, label, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await nextTick();
    }
  };
  const dispatchWire = (overrides = {}) => ({
    id: 'disp_1',
    prompt: 'Fix the signup bug',
    taskId: 'jd7task1',
    project: { id: null, name: 'futuremail', repoId: 'repo_fm' },
    modelId: null,
    accessMode: 'auto-edit',
    sourceChat: { threadId: 'chat1', messageId: 'm1', url: 'https://durango.sh/c/chat1' },
    createdAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  });

  const makeWorker = (overrides = {}) => {
    const calls = { starts: [], stops: [], notifications: [], sleeps: [] };
    const worker = createDispatchWorker({
      client,
      getMachineId: async () => 'device-uuid-1',
      getMachineName: () => 'Test Mac',
      platform: 'darwin',
      isSignedIn: async () => Boolean(session.value),
      startRun: async (input) => {
        calls.starts.push(input);
        return overrides.startResult ?? { ok: true, threadId: `thread-${calls.starts.length}`, threadTitle: 'Fix signup' };
      },
      stopRun: async (threadId) => {
        calls.stops.push(threadId);
      },
      notify: (payload) => calls.notifications.push(payload),
      // Fast, abortable sleeps; delays are recorded for the backoff check.
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          calls.sleeps.push(ms);
          if (signal?.aborted) return resolve();
          const timer = setTimeout(resolve, 2);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        }),
      random: () => 0.5,
      heartbeatMs: overrides.heartbeatMs ?? 60_000,
      reportRetryDelaysMs: [1],
      log: () => {},
      ...overrides.deps,
    });
    liveWorkers.add(worker);
    return { worker, calls };
  };

  const claimsSoFar = () => server.requests.filter((request) => request.path === '/api/v1/code/dispatches/claim');
  const reports = (id = 'disp_1') => server.requests.filter((request) => request.path === `/api/v1/code/dispatches/${id}`).map((request) => request.body);

  await test('claim loop: registers, long-polls, null results keep polling, dispatch starts a run and reports running', async () => {
    let claims = 0;
    server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/claim', async (_req, body) => {
      claims += 1;
      assert.equal(body.machineId, 'device-uuid-1');
      assert.equal(body.waitMs, 25_000);
      if (claims === 3) return { json: { dispatch: dispatchWire() } };
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { json: { dispatch: null } };
    });
    server.always('POST', '/api/v1/code/dispatches/disp_1', () => ({ json: { ok: true } }));
    const { worker, calls } = makeWorker();
    worker.configure({ settings: { enabled: true, accessMode: 'workspace-write', modelId: 'claude:claude-fable-5-1' }, projects });
    assert.equal(server.requests.length, 0, 'never polls while signed out');
    worker.accountChanged(true);
    // The server logs the report before answering; the notification follows the answer.
    await waitUntil(() => calls.notifications.length === 1, 'running report + notification');
    const registration = server.requests.find((request) => request.path === '/api/v1/code/machines');
    assert.deepEqual(registration.body, buildMachinePayload({ machineId: 'device-uuid-1', name: 'Test Mac', platform: 'darwin', projects }));
    assert.equal(registration.auth, 'Bearer dgo_test');
    assert.equal(calls.starts.length, 1);
    assert.equal(calls.starts[0].project.id, 'p1', 'matched by repoId');
    assert.equal(calls.starts[0].accessMode, 'workspace-write', 'auto-edit within a workspace-write ceiling');
    assert.equal(calls.starts[0].modelId, 'claude:claude-fable-5-1', 'falls back to the configured default model');
    assert.match(calls.starts[0].prompt, /^\[Started from Durango Chat: https:\/\/durango\.sh\/c\/chat1\]\n\nFix the signup bug$/);
    assert.deepEqual(reports()[0], { status: 'running', codeThreadId: 'thread-1', codeThreadTitle: 'Fix signup', machineId: 'device-uuid-1' });
    assert.equal(calls.notifications.length, 1);
    assert.equal(calls.notifications[0].project.name, 'futuremail');
    assert.equal(worker.getState().running.length, 1);
    // maxConcurrent 1: no further claims while the run is active.
    const claimsWhileBusy = claimsSoFar().length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(claimsSoFar().length, claimsWhileBusy, 'at the concurrency limit the loop stops claiming');
    assert.equal(worker.getState().status, 'busy');

    // The renderer reports the outcome; the summary is capped.
    const long = 'x'.repeat(5_000);
    const settled = await worker.settle({ dispatchId: 'disp_1', threadId: 'thread-1', outcome: 'finished', summary: long });
    assert.equal(settled.ok, true);
    const finished = reports().at(-1);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.codeThreadId, 'thread-1');
    assert.equal(finished.machineId, 'device-uuid-1');
    assert.equal(finished.summary.length, DISPATCH_SUMMARY_MAX_CHARS);
    await waitUntil(() => claimsSoFar().length > claimsWhileBusy, 'claiming resumes after the run settles');

    // Sign-out stops the loop at once.
    worker.accountChanged(false);
    await worker.idle();
    const after = claimsSoFar().length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(claimsSoFar().length, after, 'no claims after sign-out');
    assert.equal(worker.getState().status, 'signed_out');
    worker.stop();
  });

  await test('claim errors back off exponentially; machine_not_registered re-registers', async () => {
    let claims = 0;
    server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/claim', () => {
      claims += 1;
      if (claims === 1) return { status: 404, json: durangoErrorBody('Register this machine first.', 'machine_not_registered') };
      if (claims <= 4) return { status: 503, json: durangoErrorBody('Durango is temporarily unavailable.', 'dispatch_unavailable') };
      return { json: { dispatch: null } };
    });
    const { worker, calls } = makeWorker();
    worker.configure({ settings: { enabled: true }, projects });
    worker.accountChanged(true);
    await waitUntil(() => claims >= 6, 'claims after errors');
    const registrations = server.requests.filter((request) => request.path === '/api/v1/code/machines').length;
    assert.equal(registrations, 2, 'registered at start and again after machine_not_registered');
    assert.deepEqual(calls.sleeps.slice(0, 3), [1_000, 2_000, 4_000], 'exponential backoff on 5xx');
    worker.stop();
    await worker.idle();
  });

  await test('unknown or blocked project → failed report with a clear error, nothing starts', async () => {
    let claims = 0;
    server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/claim', async () => {
      claims += 1;
      if (claims === 1) return { json: { dispatch: dispatchWire({ id: 'disp_missing', project: { id: null, name: 'nope', repoId: null } }) } };
      if (claims === 2) return { json: { dispatch: dispatchWire({ id: 'disp_blocked', project: { id: 'p3', name: 'secret', repoId: 'repo_secret' } }) } };
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { json: { dispatch: null } };
    });
    server.always('POST', '/api/v1/code/dispatches/disp_missing', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/disp_blocked', () => ({ json: { ok: true } }));
    const { worker, calls } = makeWorker();
    worker.configure({ settings: { enabled: true, allowedProjectIds: ['p1', 'p2'] }, projects });
    worker.accountChanged(true);
    await waitUntil(() => reports('disp_missing').length && reports('disp_blocked').length, 'failed reports');
    assert.equal(calls.starts.length, 0);
    assert.equal(reports('disp_missing')[0].status, 'failed');
    assert.match(reports('disp_missing')[0].error, /no project matching "nope"/);
    assert.match(reports('disp_blocked')[0].error, /not allowed to run agents from Durango on this Mac/);
    const registration = server.requests.find((request) => request.path === '/api/v1/code/machines');
    assert.deepEqual(registration.body.projects.map((project) => project.id), ['p1', 'p2'], 'only allowlisted projects are advertised');
    worker.stop();
    await worker.idle();
  });

  await test('renderer start failure → failed; heartbeat 409 (cancelled in chat) stops the run', async () => {
    // Start failure.
    {
      let claims = 0;
      server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
      server.always('POST', '/api/v1/code/dispatches/claim', async () => {
        claims += 1;
        if (claims === 1) return { json: { dispatch: dispatchWire({ id: 'disp_nostart' }) } };
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { json: { dispatch: null } };
      });
      server.always('POST', '/api/v1/code/dispatches/disp_nostart', () => ({ json: { ok: true } }));
      const { worker } = makeWorker({ startResult: { ok: false, error: 'Project not found on this machine.' } });
      worker.configure({ settings: { enabled: true }, projects });
      worker.accountChanged(true);
      await waitUntil(() => reports('disp_nostart').length, 'start failure report');
      assert.deepEqual(reports('disp_nostart')[0], { status: 'failed', error: 'Project not found on this machine.', machineId: 'device-uuid-1' });
      worker.stop();
      await worker.idle();
    }
    server.reset();
    // Cancelled from chat: the heartbeat gets 409 invalid_transition.
    {
      let claims = 0;
      let heartbeats = 0;
      server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
      server.always('POST', '/api/v1/code/dispatches/claim', async () => {
        claims += 1;
        if (claims === 1) return { json: { dispatch: dispatchWire({ id: 'disp_cancel' }) } };
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { json: { dispatch: null } };
      });
      server.always('POST', '/api/v1/code/dispatches/disp_cancel', () => {
        heartbeats += 1;
        if (heartbeats === 1) return { json: { ok: true } };
        return { status: 409, json: durangoErrorBody('Dispatch is already cancelled.', 'invalid_transition') };
      });
      const { worker, calls } = makeWorker({ heartbeatMs: 20 });
      worker.configure({ settings: { enabled: true }, projects });
      worker.accountChanged(true);
      await waitUntil(() => calls.stops.length === 1, 'stop after cancel');
      assert.equal(calls.stops[0], 'thread-1');
      assert.equal(reports('disp_cancel').filter((report) => report.status === 'running').length >= 2, true, 'running is re-posted as the heartbeat');
      assert.equal(worker.getState().running.length, 0);
      const settled = await worker.settle({ dispatchId: 'disp_cancel', threadId: 'thread-1', outcome: 'failed', error: 'Stopped' });
      assert.equal(settled.skipped, true, 'no final report for a run cancelled from chat');
      worker.stop();
      await worker.idle();
    }
  });

  await test('settle for a dispatch from a previous app session still reports', async () => {
    server.always('POST', '/api/v1/code/dispatches/disp_old', () => ({ json: { ok: true } }));
    const { worker } = makeWorker();
    const result = await worker.settle({ dispatchId: 'disp_old', threadId: 't9', outcome: 'failed', error: 'Durango Code quit before the agent finished.' });
    assert.equal(result.ok, true);
    assert.deepEqual(reports('disp_old')[0], { status: 'failed', codeThreadId: 't9', error: 'Durango Code quit before the agent finished.', machineId: 'device-uuid-1' });
  });

  await test('suspend pauses polling; resume restarts it', async () => {
    server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/claim', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { json: { dispatch: null } };
    });
    const { worker } = makeWorker();
    worker.configure({ settings: { enabled: true }, projects });
    worker.accountChanged(true);
    await waitUntil(() => claimsSoFar().length > 0, 'first claim');
    worker.suspend();
    await worker.idle();
    assert.equal(worker.getState().status, 'paused');
    const paused = claimsSoFar().length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(claimsSoFar().length, paused);
    worker.resume();
    await waitUntil(() => claimsSoFar().length > paused, 'claims after resume');
    worker.stop();
    await worker.idle();
  });

  await test('client: claim normalizes the Dispatch type and maps errors', async () => {
    server.on('POST', '/api/v1/code/dispatches/claim', () => ({
      json: { dispatch: { id: 'd', prompt: 'p', taskId: null, project: { id: null, name: 'x', repoId: null }, modelId: '', accessMode: 'weird', sourceChat: null, createdAt: 'now' } },
    }));
    const { dispatch } = await client.claimDispatch({ machineId: 'm' });
    assert.deepEqual(dispatch, { id: 'd', origin: 'chat', prompt: 'p', taskId: null, taskUrl: null, project: { id: null, name: 'x', repoId: null }, modelId: null, accessMode: null, sourceChat: null, createdAt: 'now' });
    server.on('POST', '/api/v1/code/dispatches/x', () => ({ status: 409, json: durangoErrorBody('Another machine claimed this dispatch.', 'claimed_elsewhere') }));
    await assert.rejects(client.reportDispatch('x', { status: 'running' }), (error) => error instanceof DurangoError && error.status === 409 && error.apiCode === 'claimed_elsewhere');
  });

  // ======================================================================================
  // Renderer: when a dispatched thread counts as settled
  // ======================================================================================

  await test('renderer outcome: finished summary, error, stop, restart, still running', () => {
    const dispatch = { id: 'd1', sourceUrl: null, startedAt: '2026-10-13T00:00:00.000Z' };
    const run = (fields) => ({ id: 'm', role: 'agent', kind: 'agent-run', content: '', ts: 'x', ...fields });
    assert.equal(durangoDispatchOutcome({ status: 'running', messages: [run({ status: 'running' })], durangoDispatch: dispatch }), null);
    assert.equal(durangoDispatchOutcome({ status: 'idle', messages: [], durangoDispatch: dispatch }), null, 'not started yet');
    assert.deepEqual(durangoDispatchOutcome({ status: 'done', messages: [run({ status: 'done', content: 'Fixed it.' })], durangoDispatch: dispatch }), { outcome: 'finished', summary: 'Fixed it.' });
    assert.deepEqual(durangoDispatchOutcome({ status: 'error', messages: [run({ status: 'error', error: 'claude exited with code 1.' })], durangoDispatch: dispatch }), { outcome: 'failed', error: 'claude exited with code 1.' });
    assert.match(durangoDispatchOutcome({ status: 'idle', messages: [run({ status: 'stopped' })], durangoDispatch: dispatch }).error, /Stopped in Durango Code/);
    assert.match(durangoDispatchOutcome({ status: 'idle', messages: [run({ status: 'stopped', statusText: 'Interrupted by app restart.' })], durangoDispatch: dispatch }).error, /quit before/);
    assert.equal(durangoDispatchOutcome({ status: 'done', messages: [run({ status: 'done' })], durangoDispatch: { ...dispatch, reportedAt: 'x' } }), null, 'reported once');
    const summary = dispatchSummaryText('a'.repeat(100) + 'THE END', 20);
    assert.equal(summary.length, 20);
    assert.ok(summary.startsWith('…') && summary.endsWith('THE END'), 'keeps the conclusion at the end');
  });
} finally {
  await server.close();
  await fs.rm(testRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log('durango dispatch + tasks: all tests passed');
