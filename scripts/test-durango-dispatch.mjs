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
  capThreadAccessMode,
  clampDispatchAccessMode,
  createDispatchWorker,
  dispatchSourceLabel,
  normalizeDispatchSettings,
  resolveDispatchProject,
  resolveFollowUpProject,
  SOURCE_CHECKOUT_CAPABILITY,
  API_SOURCE_CHECKOUT_CAPABILITY,
  canCheckoutDispatch,
  registeredModels,
  resolveDispatchModel,
  dispatchEffort,
} from '../src/main/durango-dispatch.js';
import { checkoutFolderName, chooseCheckoutDir, cliSupportsClone, createSourceCheckout, sourceCheckoutRoot } from '../src/main/source-checkout.js';
import { linuxPasswordStore } from '../src/main/linux-password-store-policy.js';
import {
  BOT_TASK_SUMMARY_MAX_CHARS,
  DISPATCH_STUCK_AFTER_MS,
  DISPATCH_SUMMARY_MAX_CHARS as RENDERER_DISPATCH_SUMMARY_MAX_CHARS,
  activityToolName,
  dispatchRunFinalText,
  durangoDispatchHasNewRuns,
  durangoDispatchLiveRun,
  durangoDispatchLiveRunAt,
  durangoDispatchOutcome,
  dispatchSummaryText,
  pendingInputText,
  runWaitsOnItself,
  safeApprovalReason,
  startDurangoDispatchNotices,
  startDurangoDispatchReporter,
  userActionText,
} from '../src/app/durangoDispatch.ts';
import { clipMiddle } from '../src/report-clip.js';
// stream-adapters.js as a plain Node module (its one Electron import is a seam):
// the Claude driver builds a run's steps with it.
const { extractActivitiesFromJsonEvent } = await import(
  `data:text/javascript;base64,${Buffer.from(
    (await fs.readFile(new URL('../src/main/stream-adapters.js', import.meta.url), 'utf8'))
      .replace("import { shell } from 'electron';", 'const shell = {};')
      .replace("import path from 'node:path';", "import path from 'node:path';")
  ).toString('base64')}`
);

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
const client = createDurangoClient({ credentials, readSession: async () => session.value, isPackaged: () => false, webOrigin: () => base });

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
      capabilities: ['thread-follow-up', 'model-choice', 'project-notes'],
      models: [],
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
    assert.equal(clampDispatchAccessMode('auto-edit', 'full-access'), 'full-access', 'auto-edit gets the Mac limit');
    assert.equal(clampDispatchAccessMode('ask', 'workspace-write'), 'read-only');
    assert.equal(clampDispatchAccessMode(null, 'workspace-write'), 'workspace-write');
    assert.equal(clampDispatchAccessMode(null, 'bogus'), 'read-only');
    assert.equal(normalizeDispatchSettings({}).accessMode, 'read-only', 'default is the most conservative mode');
    assert.equal(normalizeDispatchSettings({}).enabled, false, 'off by default');
    assert.equal(normalizeDispatchSettings({}).maxRunning, null, 'no limit by default');
    assert.equal(normalizeDispatchSettings({ maxConcurrent: 1 }).maxRunning, null, 'the old 1/2 setting is dropped');
    assert.equal(normalizeDispatchSettings({ maxRunning: 4 }).maxRunning, 4);
    assert.equal(normalizeDispatchSettings({ maxRunning: 0 }).maxRunning, null);
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
    worker.configure({ settings: { enabled: true, accessMode: 'workspace-write', modelId: 'claude:claude-fable-5-1', maxRunning: 1 }, projects });
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
    // maxRunning 1: no further claims while the run is active.
    const claimsWhileBusy = claimsSoFar().length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(claimsSoFar().length, claimsWhileBusy, 'at the concurrency limit the loop stops claiming');
    assert.equal(worker.getState().status, 'busy');

    // The renderer reports the outcome; the summary is capped by trimming only the middle.
    const long = 'OPENING SUMMARY: ' + 'x'.repeat(5_000) + ' CLOSING RESULT';
    const settled = await worker.settle({ dispatchId: 'disp_1', threadId: 'thread-1', outcome: 'finished', summary: long });
    assert.equal(settled.ok, true);
    const finished = reports().at(-1);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.codeThreadId, 'thread-1');
    assert.equal(finished.machineId, 'device-uuid-1');
    assert.equal(DISPATCH_SUMMARY_MAX_CHARS, 4_000);
    assert.ok(finished.summary.length <= DISPATCH_SUMMARY_MAX_CHARS);
    assert.ok(finished.summary.startsWith('OPENING SUMMARY:'), 'keeps opening summary');
    assert.ok(finished.summary.endsWith('CLOSING RESULT'), 'keeps closing result');
    assert.match(finished.summary, /…\[middle trimmed\]…/);
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

  await test('no limit by default: claiming continues while runs are active', async () => {
    let claims = 0;
    server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/claim', async () => {
      claims += 1;
      if (claims <= 3) return { json: { dispatch: dispatchWire({ id: `disp_n${claims}` }) } };
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { json: { dispatch: null } };
    });
    for (const n of [1, 2, 3]) server.always('POST', `/api/v1/code/dispatches/disp_n${n}`, () => ({ json: { ok: true } }));
    const { worker, calls } = makeWorker();
    worker.configure({ settings: { enabled: true }, projects });
    worker.accountChanged(true);
    await waitUntil(() => calls.starts.length === 3 && claims > 3, 'three runs started and still claiming');
    assert.equal(worker.getState().running.length, 3);
    assert.equal(worker.getState().maxRunning, null);
    assert.notEqual(worker.getState().status, 'busy');
    worker.stop();
    await worker.idle();
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

  await test('source checkout: a repo this machine lacks is cloned, added, then run; capability needs no allowlist', async () => {
    assert.ok(canCheckoutDispatch({ project: { repoId: 'repo_new' } }, null, true));
    assert.ok(!canCheckoutDispatch({ project: { repoId: 'repo_new' } }, ['p1'], true), 'an allowlist never grows by itself');
    assert.ok(!canCheckoutDispatch({ project: { name: 'x' } }, null, true), 'nothing to clone without a repo id');
    assert.ok(!canCheckoutDispatch({ project: { repoId: 'r' }, threadId: 't' }, null, true), 'follow-ups need their thread');
    assert.ok(!canCheckoutDispatch({ project: { repoId: 'r' } }, null, false));
    assert.ok(canCheckoutDispatch({ origin: 'api', project: { repoId: 'repo_new' } }, null, true), 'API runs clone with this machine sign-in');
    assert.ok(canCheckoutDispatch({ origin: 'tasks', project: { repoId: 'repo_new' } }, null, true));
    assert.deepEqual(
      buildMachinePayload({ machineId: 'm', name: 'omarchy', platform: 'linux', projects: [], sourceCheckout: true }).capabilities,
      ['thread-follow-up', 'model-choice', 'project-notes', SOURCE_CHECKOUT_CAPABILITY, API_SOURCE_CHECKOUT_CAPABILITY]
    );
    assert.deepEqual(
      buildMachinePayload({ machineId: 'm', name: 'omarchy', platform: 'linux', projects: [], allowedProjectIds: ['p1'], sourceCheckout: true }).capabilities,
      ['thread-follow-up', 'model-choice', 'project-notes'],
      "'project-notes': Durango pastes no notes into threads started here"
    );

    let claims = 0;
    server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/claim', async () => {
      claims += 1;
      if (claims === 1) return { json: { dispatch: dispatchWire({ id: 'disp_clone', project: { id: null, name: 'durango', repoId: 'repo_durango' } }) } };
      if (claims === 2) return { json: { dispatch: dispatchWire({ id: 'disp_clone_fail', project: { id: null, name: 'broken', repoId: 'repo_broken' } }) } };
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { json: { dispatch: null } };
    });
    server.always('POST', '/api/v1/code/dispatches/disp_clone', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/disp_clone_fail', () => ({ json: { ok: true } }));
    const checkouts = [];
    const { worker, calls } = makeWorker({
      heartbeatMs: 5,
      deps: {
        checkoutProject: async ({ repoId, name }) => {
          checkouts.push({ repoId, name });
          await new Promise((resolve) => setTimeout(resolve, 30)); // a slow clone: heartbeats meanwhile
          if (repoId === 'repo_broken') throw new Error('git clone failed: not found');
          return { id: 'p-new', name, path: '/home/me/Durango/durango', repoId };
        },
      },
    });
    worker.configure({ settings: { enabled: true }, projects });
    worker.accountChanged(true);
    await waitUntil(() => calls.starts.length === 1 && reports('disp_clone_fail').some((body) => body.status === 'failed'), 'clone, run, and a failed clone');
    const registration = server.requests.find((request) => request.path === '/api/v1/code/machines');
    assert.ok(registration.body.capabilities.includes(SOURCE_CHECKOUT_CAPABILITY));
    assert.deepEqual(checkouts.map((item) => item.repoId), ['repo_durango', 'repo_broken']);
    assert.equal(calls.starts[0].project.id, 'p-new', 'runs in the new checkout');
    const before = reports('disp_clone').filter((body) => body.status === 'running' && !body.codeThreadId);
    assert.ok(before.length >= 2, 'running heartbeats keep the lease while cloning');
    assert.equal(reports('disp_clone').at(-1).codeThreadId, 'thread-1');
    assert.match(reports('disp_clone_fail').at(-1).error, /Could not check out broken from Durango Source: git clone failed/);
    await waitUntil(
      () => server.requests.filter((request) => request.path === '/api/v1/code/machines').some((request) => request.body.projects.some((project) => project.id === 'p-new')),
      'the checkout is advertised'
    );
    worker.stop();
    await worker.idle();
  });

  await test('source checkout: an allowlist set while cloning means nothing runs', async () => {
    let claims = 0;
    server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/claim', async () => {
      claims += 1;
      if (claims === 1) return { json: { dispatch: dispatchWire({ id: 'disp_revoked', project: { id: null, name: 'durango', repoId: 'repo_durango' } }) } };
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { json: { dispatch: null } };
    });
    server.always('POST', '/api/v1/code/dispatches/disp_revoked', () => ({ json: { ok: true } }));
    let release;
    let worker;
    const made = makeWorker({
      deps: {
        checkoutProject: async ({ name, repoId }) => {
          // Restricted to one project while the clone runs.
          worker.configure({ settings: { enabled: true, allowedProjectIds: ['p1'] }, projects });
          await new Promise((resolve) => (release = resolve));
          return { id: 'p-new', name, path: '/x', repoId };
        },
      },
    });
    worker = made.worker;
    worker.configure({ settings: { enabled: true }, projects });
    worker.accountChanged(true);
    await waitUntil(() => typeof release === 'function', 'clone started');
    release();
    await waitUntil(() => reports('disp_revoked').some((body) => body.status === 'failed'), 'failed report');
    assert.equal(made.calls.starts.length, 0, 'nothing started');
    assert.match(reports('disp_revoked').at(-1).error, /turned off or restricted/);
    worker.stop();
    await worker.idle();
  });

  await test('source checkout module: folder choice, reuse, one clone per repo, CLI version gate', async () => {
    assert.equal(checkoutFolderName('durango', 'r1'), 'durango');
    assert.equal(checkoutFolderName(' my app/../x ', 'r1'), 'my-app-x');
    assert.equal(checkoutFolderName('', 'repo_9'), 'repo_9');
    assert.equal(sourceCheckoutRoot({}, '/home/me'), '/home/me/Durango');
    assert.equal(sourceCheckoutRoot({ DURANGO_CHECKOUT_ROOT: '/srv/code' }, '/home/me'), '/srv/code');
    assert.ok(cliSupportsClone('0.10.0') && cliSupportsClone('1.0.0') && cliSupportsClone('0.10.3'));
    assert.ok(!cliSupportsClone('0.9.9') && !cliSupportsClone('0.8.12') && !cliSupportsClone(null));

    const root = await fs.mkdtemp(path.join(testRoot, 'checkouts-'));
    await fs.mkdir(path.join(root, 'durango'));
    await fs.writeFile(path.join(root, 'durango', 'other.txt'), 'x');
    const links = { [path.join(root, 'durango')]: 'repo_other' };
    assert.equal(
      await chooseCheckoutDir(root, { repoId: 'repo_d', name: 'durango' }, async (dir) => links[dir] ?? null),
      path.join(root, 'durango-repo_d'),
      'a folder holding something else gets the repo id appended'
    );
    links[path.join(root, 'durango')] = 'repo_d';
    assert.equal(await chooseCheckoutDir(root, { repoId: 'repo_d', name: 'durango' }, async (dir) => links[dir] ?? null), path.join(root, 'durango'), 'its own clone is reused');

    const runs = [];
    const added = [];
    const checkout = createSourceCheckout({
      root: () => root,
      prepareCli: async () => {},
      runCli: async (args) => {
        runs.push(args);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { code: 0, json: { ok: true, path: args[2], name: 'site', env: { written: ['.env.local'] } } };
      },
      addProject: async (project) => {
        added.push(project);
        return { id: 'p-site' };
      },
    });
    const [first, second] = await Promise.all([checkout({ repoId: 'repo_site', name: 'site' }), checkout({ repoId: 'repo_site', name: 'site' })]);
    assert.equal(runs.length, 1, 'concurrent requests share one clone');
    assert.deepEqual(runs[0], ['clone', 'repo_site', path.join(root, 'site'), '--json']);
    assert.equal(first, second);
    assert.deepEqual(first, { id: 'p-site', name: 'site', path: path.join(root, 'site'), repoId: 'repo_site', env: { written: ['.env.local'] }, envError: null });
    assert.deepEqual(added, [{ name: 'site', path: path.join(root, 'site') }]);
    await assert.rejects(checkout({ repoId: '../x' }), /repository id is required/);
    await assert.rejects(checkout({ repoId: '--upload-pack=x' }), /repository id is required/, 'never a CLI flag');

    // Cancelling one caller of a shared clone leaves it running for the other.
    let cloneSignal = null;
    let finishClone;
    const shared = createSourceCheckout({
      root: () => root,
      prepareCli: async () => {},
      runCli: async (args, options) => {
        cloneSignal = options.signal;
        await new Promise((resolve) => (finishClone = resolve));
        return { code: 0, json: { ok: true, path: args[2], name: 'mono' } };
      },
      addProject: async () => ({ id: 'p-mono' }),
    });
    const firstCaller = new AbortController();
    const firstRun = shared({ repoId: 'repo_mono', name: 'mono', signal: firstCaller.signal });
    const secondRun = shared({ repoId: 'repo_mono', name: 'mono', signal: new AbortController().signal });
    await waitUntil(() => cloneSignal !== null, 'the shared clone started');
    firstCaller.abort();
    await assert.rejects(firstRun, /cancelled/);
    assert.equal(cloneSignal.aborted, false, 'still wanted by the second caller');
    finishClone();
    assert.equal((await secondRun).id, 'p-mono');
    // The last caller cancelling stops it.
    cloneSignal = null;
    const only = new AbortController();
    const onlyRun = shared({ repoId: 'repo_solo', name: 'solo', signal: only.signal });
    await waitUntil(() => cloneSignal !== null, 'the solo clone started');
    only.abort();
    await assert.rejects(onlyRun, /cancelled/);
    assert.equal(cloneSignal.aborted, true);
    finishClone();

    const failing = createSourceCheckout({
      root: () => root,
      prepareCli: async () => {},
      runCli: async () => ({ code: 1, json: { ok: false, error: 'No Durango Cloud repo nope is visible to this account.' } }),
      cliError: (result, fallback) => result?.json?.error || fallback,
      addProject: async () => ({ id: 'never' }),
    });
    await assert.rejects(failing({ repoId: 'nope' }), /No Durango Cloud repo nope/);

    const reuse = createSourceCheckout({
      root: () => root,
      prepareCli: async () => assert.fail('an existing checkout needs no CLI'),
      runCli: async () => assert.fail('no clone'),
      addProject: async () => assert.fail('no add'),
      existingProject: async (repoId) => (repoId === 'repo_here' ? { id: 'p-here', name: 'here', path: '/x', repoId } : null),
    });
    assert.equal((await reuse({ repoId: 'repo_here' })).id, 'p-here');
  });

  await test('linux password store: tiling compositors ask for the Secret Service', () => {
    assert.equal(linuxPasswordStore({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'Hyprland' } }), 'gnome-libsecret');
    assert.equal(linuxPasswordStore({ platform: 'linux', env: {} }), 'gnome-libsecret');
    assert.equal(linuxPasswordStore({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' } }), null);
    assert.equal(linuxPasswordStore({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'KDE' } }), null);
    assert.equal(linuxPasswordStore({ platform: 'linux', argv: ['--password-store=basic'], env: {} }), null);
    assert.equal(linuxPasswordStore({ platform: 'linux', env: { DURANGO_PASSWORD_STORE: 'kwallet6', XDG_CURRENT_DESKTOP: 'sway' } }), 'kwallet6');
    assert.equal(linuxPasswordStore({ platform: 'darwin', env: {} }), null);
  });

  await test('API runs: labelled with the key, follow-ups say "Sent from"', () => {
    assert.equal(dispatchSourceLabel({ origin: 'api', sourceLabel: 'Grok (MCP)' }), 'Grok (MCP) via Durango');
    assert.equal(dispatchSourceLabel({ origin: 'api', sourceLabel: null }), 'the Durango API');
    // A cloud bot's machine task shows as started by that bot (and the bot may settle its thread).
    assert.equal(dispatchSourceLabel({ origin: 'chat', bot: 'Durango' }), 'your bot Durango');
    assert.equal(dispatchSourceLabel({ origin: 'chat', bot: '  ' }), 'Durango Chat');
    assert.equal(buildDispatchPrompt({ origin: 'api', sourceLabel: 'Grok (MCP)', prompt: 'Fix it', sourceChat: null }), '[Started from Grok (MCP) via Durango]\n\nFix it');
    assert.equal(buildDispatchPrompt({ origin: 'api', sourceLabel: 'Grok (MCP)', threadId: 't1', prompt: 'Add a test', sourceChat: null }), '[Sent from Grok (MCP) via Durango]\n\nAdd a test');
  });

  await test('follow-up without an access mode keeps the thread\'s, capped by this Mac\'s limit', () => {
    assert.equal(capThreadAccessMode('workspace-write', 'full-access'), 'workspace-write');
    assert.equal(capThreadAccessMode('full-access', 'read-only'), 'read-only');
    assert.equal(capThreadAccessMode('read-only', 'full-access'), 'read-only');
    assert.equal(capThreadAccessMode(undefined, 'full-access'), 'read-only', 'unknown thread access = read-only');
  });

  await test('follow-up project: the thread must be here and its project allowlisted', () => {
    assert.match(resolveFollowUpProject({}, undefined, projects, null).error, /not on this Mac/);
    assert.equal(resolveFollowUpProject({}, 'p2', projects, ['p1', 'p2']).project.id, 'p2');
    assert.match(resolveFollowUpProject({}, 'p3', projects, ['p1']).error, /"secret" is not allowed/);
    assert.deepEqual(resolveFollowUpProject({}, null, projects, null), { ok: true, project: null }, 'a thread without a project, all projects allowed');
    assert.match(resolveFollowUpProject({}, null, projects, ['p1']).error, /This thread is not allowed/);
  });

  await test('follow-up dispatch continues its thread with the thread\'s model; a missing thread fails', async () => {
    let claims = 0;
    server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/claim', async () => {
      claims += 1;
      if (claims === 1) return { json: { dispatch: dispatchWire({ id: 'disp_follow', origin: 'api', sourceLabel: 'Grok (MCP)', threadId: 'thread-7', taskId: null, sourceChat: null, project: {}, accessMode: 'ask', prompt: 'Now add tests' }) } };
      if (claims === 2) return { json: { dispatch: dispatchWire({ id: 'disp_gone', origin: 'api', threadId: 'thread-gone', taskId: null, sourceChat: null, project: {} }) } };
      if (claims === 3) return { json: { dispatch: dispatchWire({ id: 'disp_keep', origin: 'api', threadId: 'thread-7', taskId: null, sourceChat: null, project: {}, accessMode: null, prompt: 'Keep going' }) } };
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { json: { dispatch: null } };
    });
    server.always('POST', '/api/v1/code/dispatches/disp_follow', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/disp_gone', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/disp_keep', () => ({ json: { ok: true } }));
    const { worker, calls } = makeWorker({
      startResult: { ok: true, threadId: 'thread-7' },
      deps: { getThread: async (threadId) => (threadId === 'thread-7' ? { projectId: 'p1', accessMode: 'workspace-write' } : undefined) },
    });
    worker.configure({ settings: { enabled: true, accessMode: 'full-access', modelId: 'claude:claude-fable-5-1' }, projects });
    worker.accountChanged(true);
    await waitUntil(() => reports('disp_follow').length && reports('disp_gone').length && reports('disp_keep').length, 'follow-up reports');
    assert.equal(calls.starts.length, 2);
    assert.equal(calls.starts[1].accessMode, 'workspace-write', 'no access mode: the thread keeps its own');
    assert.equal(calls.starts[0].threadId, 'thread-7');
    assert.equal(calls.starts[0].project.id, 'p1');
    assert.equal(calls.starts[0].modelId, null, 'keeps the thread\'s model instead of the default for new runs');
    assert.equal(calls.starts[0].accessMode, 'read-only', 'ask runs read-only');
    assert.match(calls.starts[0].prompt, /^\[Sent from Grok \(MCP\) via Durango\]\n\nNow add tests$/);
    assert.deepEqual(reports('disp_follow')[0], { status: 'running', codeThreadId: 'thread-7', machineId: 'device-uuid-1' });
    assert.equal(reports('disp_gone')[0].status, 'failed');
    assert.match(reports('disp_gone')[0].error, /not on this Mac/);
    worker.stop();
    await worker.idle();
  });

  const MODELS = [
    { id: 'claude:claude-haiku-5-5', label: 'Haiku 5.5', slug: 'claude-haiku-5-5', provider: 'Claude', efforts: ['low', 'medium', 'high'], available: true },
    { id: 'codex:gpt-6-luna', label: 'GPT-6 Luna', slug: 'gpt-6-luna', provider: 'Codex', efforts: ['low', 'max'], available: true },
    { id: 'grok:grok-4.7', label: 'Grok 4.7', slug: 'grok-4.7', provider: 'Grok', efforts: ['low'], available: false, unavailableReason: 'Install or authenticate grok on PATH.' },
  ];

  await test('models: registration lists available ones; a requested model resolves by id, slug or label', () => {
    assert.deepEqual(registeredModels(MODELS), [
      { id: 'claude:claude-haiku-5-5', label: 'Haiku 5.5', provider: 'Claude', efforts: ['low', 'medium', 'high'] },
      { id: 'codex:gpt-6-luna', label: 'GPT-6 Luna', provider: 'Codex', efforts: ['low', 'max'] },
    ]);
    assert.deepEqual(buildMachinePayload({ machineId: 'm', name: 'omarchy', platform: 'linux', projects: [], models: MODELS }).models.map((model) => model.id), ['claude:claude-haiku-5-5', 'codex:gpt-6-luna']);
    assert.equal(resolveDispatchModel('claude:claude-haiku-5-5', MODELS).model.id, 'claude:claude-haiku-5-5');
    assert.equal(resolveDispatchModel('claude-haiku-5-5', MODELS).model.id, 'claude:claude-haiku-5-5', 'slug');
    assert.equal(resolveDispatchModel('haiku 5.5', MODELS).model.id, 'claude:claude-haiku-5-5', 'label, any case');
    assert.deepEqual(resolveDispatchModel(null, MODELS), { ok: true, model: null });
    const unknown = resolveDispatchModel('claude:claude-haiku-9', MODELS, 'omarchy');
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /omarchy has no model "claude:claude-haiku-9". Models there: claude:claude-haiku-5-5, codex:gpt-6-luna\./);
    assert.match(resolveDispatchModel('grok:grok-4.7', MODELS, 'omarchy').error, /Grok 4.7 isn't available on omarchy. Install or authenticate grok/);
    // Ids are never cut; leaving models out marks the list partial.
    const long = { id: `opencode:${'x'.repeat(130)}`, label: 'Long', provider: 'OpenCode', efforts: [], available: true };
    assert.deepEqual(registeredModels([MODELS[0], long]).map((model) => model.id), ['claude:claude-haiku-5-5']);
    assert.equal(buildMachinePayload({ machineId: 'm', name: 'x', platform: 'linux', projects: [], models: [MODELS[0], long] }).modelsTruncated, true);
    assert.equal(buildMachinePayload({ machineId: 'm', name: 'x', platform: 'linux', projects: [], models: MODELS }).modelsTruncated, undefined, 'unavailable ones are not "left out"');
    assert.equal(dispatchEffort('HIGH', MODELS[0]), 'high');
    assert.equal(dispatchEffort('HIGH', null), 'high');
    assert.equal(dispatchEffort('', MODELS[0]), null);
  });

  await test('a dispatch runs the model and effort it named; an unknown model fails without starting', async () => {
    let claims = 0;
    server.always('POST', '/api/v1/code/machines', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/claim', async () => {
      claims += 1;
      if (claims === 1) return { json: { dispatch: dispatchWire({ id: 'disp_model', origin: 'api', modelId: 'Haiku 5.5', reasoningEffort: 'High' }) } };
      if (claims === 2) return { json: { dispatch: dispatchWire({ id: 'disp_nomodel', origin: 'api', modelId: 'claude:claude-haiku-9' }) } };
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { json: { dispatch: null } };
    });
    server.always('POST', '/api/v1/code/dispatches/disp_model', () => ({ json: { ok: true } }));
    server.always('POST', '/api/v1/code/dispatches/disp_nomodel', () => ({ json: { ok: true } }));
    const { worker, calls } = makeWorker({ deps: { listModels: async () => MODELS } });
    worker.configure({ settings: { enabled: true, accessMode: 'full-access', modelId: 'claude:gone' }, projects });
    worker.accountChanged(true);
    await waitUntil(() => reports('disp_model').length && reports('disp_nomodel').length, 'model reports');
    const registration = server.requests.find((request) => request.path === '/api/v1/code/machines');
    assert.deepEqual(registration.body.models, registeredModels(MODELS), 'registers its models');
    assert.equal(calls.starts.length, 1);
    assert.equal(calls.starts[0].modelId, 'claude:claude-haiku-5-5', 'resolved to the exact id');
    assert.equal(calls.starts[0].reasoningEffort, 'high');
    assert.equal(reports('disp_nomodel')[0].status, 'failed');
    assert.match(reports('disp_nomodel')[0].error, /Test Mac has no model "claude:claude-haiku-9"/);
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

  await test('settle: a waiting turn and each later report of the same dispatch go out with their sequence numbers', async () => {
    server.always('POST', '/api/v1/code/dispatches/disp_bg', () => ({ json: { ok: true } }));
    const { worker } = makeWorker();
    await worker.settle({ dispatchId: 'disp_bg', threadId: 't3', outcome: 'finished', summary: 'Watching.', waiting: ['background command: deploy'], seq: 1 });
    await worker.settle({ dispatchId: 'disp_bg', threadId: 't3', outcome: 'finished', summary: 'Deployed.', seq: 4 });
    assert.deepEqual(reports('disp_bg'), [
      { status: 'finished', codeThreadId: 't3', summary: 'Watching.', waiting: ['background command: deploy'], reportSeq: 1, machineId: 'device-uuid-1' },
      { status: 'finished', codeThreadId: 't3', summary: 'Deployed.', reportSeq: 4, machineId: 'device-uuid-1' },
    ]);
  });

  await test('settle: Durango unreachable through every retry → retry later; a 4xx is final', async () => {
    server.always('POST', '/api/v1/code/dispatches/disp_down', () => ({ status: 503, json: durangoErrorBody('Down.', 'dispatch_unavailable') }));
    server.always('POST', '/api/v1/code/dispatches/disp_gone', () => ({ status: 404, json: durangoErrorBody('Dispatch not found.', 'dispatch_not_found') }));
    const { worker } = makeWorker();
    const down = await worker.settle({ dispatchId: 'disp_down', threadId: 't4', outcome: 'finished', summary: 'Done.', seq: 2 });
    assert.equal(down.ok, false);
    assert.equal(down.retry, true);
    const gone = await worker.settle({ dispatchId: 'disp_gone', threadId: 't5', outcome: 'finished', summary: 'Done.', seq: 2 });
    assert.equal(gone.ok, false);
    assert.equal(gone.retry, undefined);
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
    assert.deepEqual(dispatch, { id: 'd', origin: 'chat', prompt: 'p', taskId: null, taskUrl: null, project: { id: null, name: 'x', repoId: null }, modelId: null, reasoningEffort: null, accessMode: null, sourceChat: null, threadId: null, sourceLabel: null, bot: null, createdAt: 'now' });
    server.on('POST', '/api/v1/code/dispatches/claim', () => ({
      json: { dispatch: { id: 'd2', origin: 'api', prompt: 'more', project: {}, threadId: 'thread-9', sourceLabel: 'Grok (MCP)' } },
    }));
    const { dispatch: followUp } = await client.claimDispatch({ machineId: 'm' });
    assert.equal(followUp.origin, 'api');
    assert.equal(followUp.threadId, 'thread-9');
    assert.equal(followUp.sourceLabel, 'Grok (MCP)');
    server.on('POST', '/api/v1/code/dispatches/claim', () => ({
      json: { dispatch: { id: 'd3', prompt: 'fix', project: { name: 'x' }, bot: 'Durango' } },
    }));
    assert.equal((await client.claimDispatch({ machineId: 'm' })).dispatch.bot, 'Durango', 'a cloud bot\'s task names its bot');
    server.on('POST', '/api/v1/code/dispatches/x', () => ({ status: 409, json: durangoErrorBody('Another machine claimed this dispatch.', 'claimed_elsewhere') }));
    await assert.rejects(client.reportDispatch('x', { status: 'running' }), (error) => error instanceof DurangoError && error.status === 409 && error.apiCode === 'claimed_elsewhere');
  });

  // ======================================================================================
  // Renderer: when a dispatched thread counts as settled
  // ======================================================================================

  // The store keeps the transcript apart from the thread's shell.
  const outcomeOf = (thread) => durangoDispatchOutcome(thread, thread.messages);

  await test('renderer outcome: finished summary, error, stop, restart, still running', () => {
    const dispatch = { id: 'd1', sourceUrl: null, startedAt: '2026-10-13T00:00:00.000Z' };
    const run = (fields) => ({ id: 'm', role: 'agent', kind: 'agent-run', content: '', ts: 'x', ...fields });
    assert.equal(outcomeOf({ status: 'running', messages: [run({ status: 'running' })], durangoDispatch: dispatch }), null);
    assert.equal(outcomeOf({ status: 'idle', messages: [], durangoDispatch: dispatch }), null, 'not started yet');
    assert.deepEqual(outcomeOf({ status: 'done', messages: [run({ status: 'done', content: 'Fixed it.' })], durangoDispatch: dispatch }), { outcome: 'finished', summary: 'Fixed it.', seq: 2 });
    assert.deepEqual(outcomeOf({ status: 'error', messages: [run({ status: 'error', error: 'claude exited with code 1.' })], durangoDispatch: dispatch }), { outcome: 'failed', error: 'claude exited with code 1.', seq: 2 });
    assert.match(outcomeOf({ status: 'idle', messages: [run({ status: 'stopped' })], durangoDispatch: dispatch }).error, /Stopped in Durango Code/);
    assert.match(outcomeOf({ status: 'idle', messages: [run({ status: 'stopped', statusText: 'Interrupted by app restart.' })], durangoDispatch: dispatch }).error, /quit before/);
    assert.equal(outcomeOf({ status: 'done', messages: [run({ status: 'done' })], durangoDispatch: { ...dispatch, reportedAt: 'x' } }), null, 'reported once');
    // A follow-up counts its own run, not the thread's earlier ones.
    const followUp = { ...dispatch, runOffset: 1 };
    assert.equal(outcomeOf({ status: 'idle', messages: [run({ status: 'done', content: 'Old.' })], durangoDispatch: followUp }), null, 'its run has not started');
    assert.deepEqual(
      outcomeOf({ status: 'done', messages: [run({ status: 'done', content: 'Old.' }), run({ status: 'done', content: 'Tests added.' })], durangoDispatch: followUp }),
      { outcome: 'finished', summary: 'Tests added.', seq: 4 }
    );
    assert.equal(outcomeOf({ status: 'done', messages: [run({ status: 'done' })], durangoDispatch: { ...dispatch, reportedAt: 'x', reportedSeq: 2 } }), null, 'reported');
    assert.equal(RENDERER_DISPATCH_SUMMARY_MAX_CHARS, 4_000);
    assert.equal(BOT_TASK_SUMMARY_MAX_CHARS, 9_000);
    const summary = dispatchSummaryText('START ' + 'a'.repeat(100) + ' THE END', 20);
    assert.equal(summary.length, 20);
    assert.ok(summary.startsWith('START ') && summary.endsWith('THE END') && summary.includes('…'), 'keeps opening and closing, trims middle');
    const multiline = [
      'Shipped chg_abc123 and deployed convex-prod + andromedus.',
      ...Array.from({ length: 120 }, (_, i) => `Detail line ${i}: ${'x'.repeat(50)}`),
      'Verified live on durango.sh.\nChange: chg_abc123 https://durango.sh/c/chg_abc123',
    ].join('\n');
    const trimmed = clipMiddle(multiline, 1_000);
    assert.ok(trimmed.length <= 1_000);
    assert.ok(trimmed.startsWith('Shipped chg_abc123 and deployed convex-prod + andromedus.'));
    assert.ok(trimmed.endsWith('Verified live on durango.sh.\nChange: chg_abc123 https://durango.sh/c/chg_abc123'));
    assert.ok(trimmed.includes('\n\n…[middle trimmed]…\n\n'));
    assert.equal(clipMiddle('short', 100), 'short');
    assert.equal(clipMiddle('abc', 1), '…');
    assert.equal(clipMiddle('abc', 0), '');
  });

  await test('renderer outcome: prefers final message over earlier progress lines and uses server-aligned limits', () => {
    const dispatch = { id: 'd1', sourceUrl: null, startedAt: '2026-10-13T00:00:00.000Z' };
    const botDispatch = { id: 'bottask:t_123', sourceUrl: null, startedAt: '2026-10-13T00:00:00.000Z' };
    const localDispatch = { id: 'localbot:b1:t1', sourceUrl: null, startedAt: '2026-10-13T00:00:00.000Z' };
    const run = (fields) => ({ id: 'm', role: 'agent', kind: 'agent-run', content: '', ts: 'x', ...fields });
    const progress1 = "I'll land the change now.\n\n";
    const progress2 = "chg_123 is on the train and landing now. I'll follow the deploys…\n\n";
    const finalAnswer = 'Shipped chg_123 and deployed convex-prod + andromedus.\n\nVerified live on durango.sh.';
    const multiStep = run({
      status: 'done',
      content: `${progress1}${progress2}${finalAnswer}`,
      activities: [
        { id: 'a1', type: 'command', title: 'durango-code land', status: 'done', ts: 'x', contentOffset: progress1.length },
        { id: 'a2', type: 'command', title: 'durango-code deploys', status: 'done', ts: 'x', contentOffset: progress1.length + progress2.length },
      ],
    });
    assert.equal(dispatchRunFinalText(multiStep), finalAnswer);
    assert.deepEqual(outcomeOf({ status: 'done', messages: [multiStep], durangoDispatch: botDispatch }), {
      outcome: 'finished',
      summary: finalAnswer,
      seq: 2,
    });

    // When a turn ends on a tool call with no trailing text, keep the last non-empty text segment (not earlier progress).
    const endedOnTool = run({
      status: 'done',
      content: `${progress1}${finalAnswer}`,
      activities: [
        { id: 'a1', type: 'command', title: 'check', status: 'done', ts: 'x', contentOffset: progress1.length },
        { id: 'a2', type: 'tool', title: 'cleanup', status: 'done', ts: 'x', contentOffset: progress1.length + finalAnswer.length },
      ],
    });
    assert.equal(dispatchRunFinalText(endedOnTool), finalAnswer);

    // Inline visual/theme cards inside the final answer do not split it.
    const partA = 'Summary before chart.\n\n';
    const partB = 'Conclusion after chart.';
    const withVisual = run({
      status: 'done',
      content: `${progress1}${partA}${partB}`,
      activities: [
        { id: 'a1', type: 'command', title: 'query', status: 'done', ts: 'x', contentOffset: progress1.length },
        { id: 'a2', type: 'tool', title: 'show_html', status: 'done', ts: 'x', contentOffset: progress1.length + partA.length, visual: { id: 'v1', html: '<p>hi</p>', title: 'Chart' } },
      ],
    });
    assert.equal(dispatchRunFinalText(withVisual), `${partA}${partB}`);

    // Legacy activities without contentOffset keep the full content.
    const legacy = run({
      status: 'done',
      content: 'Legacy summary text.',
      activities: [{ id: 'a1', type: 'command', title: 'old', status: 'done', ts: 'x' }],
    });
    assert.equal(dispatchRunFinalText(legacy), 'Legacy summary text.');

    // Agent dispatch arrives whole up to 4,000 chars; bot tasks (bottask:/localbot:) arrive whole up to 9,000 chars.
    const medium = 'HEAD: ' + 'm'.repeat(3_500) + ' :TAIL';
    assert.equal(outcomeOf({ status: 'done', messages: [run({ status: 'done', content: medium })], durangoDispatch: dispatch }).summary, medium);
    const large = 'HEAD: ' + 'b'.repeat(7_500) + ' :TAIL';
    assert.equal(outcomeOf({ status: 'done', messages: [run({ status: 'done', content: large })], durangoDispatch: botDispatch }).summary, large);
    assert.equal(outcomeOf({ status: 'done', messages: [run({ status: 'done', content: large })], durangoDispatch: localDispatch }).summary, large);
    // Over 9,000 chars on a bot task: middle-trimmed, keeping opening summary and closing outcome.
    const huge = 'OPENING REPORT\n' + 'z'.repeat(11_000) + '\nCLOSING LINK';
    const hugeOutcome = outcomeOf({ status: 'done', messages: [run({ status: 'done', content: huge })], durangoDispatch: botDispatch });
    assert.ok(hugeOutcome.summary.length <= BOT_TASK_SUMMARY_MAX_CHARS);
    assert.ok(hugeOutcome.summary.startsWith('OPENING REPORT'));
    assert.ok(hugeOutcome.summary.endsWith('CLOSING LINK'));
    assert.ok(hugeOutcome.summary.includes('…[middle trimmed]…'));
  });
  await test('renderer outcome: the turns a thread resumes by itself report, the latest run is the report', () => {
    const dispatch = { id: 'd1', sourceUrl: null, startedAt: '2026-10-13T00:00:00.000Z' };
    const run = (fields) => ({ id: `m${Math.random()}`, role: 'agent', kind: 'agent-run', content: '', ts: 'x', ...fields });
    const shells = (status = 'pending') => ({
      id: 'card', role: 'system', kind: 'claude-background-intervention', content: 'Left running in the background: watch', ts: 'x',
      claudeBackgroundIntervention: { runId: 'r', tasks: ['watch the change for a new commit'], status },
    });
    // The case that went silent: every turn waited on a background command (the
    // thread stayed Working), and the report named the first turn's words.
    const waitedThrough = [
      run({ status: 'done', content: "I'm waiting for the amend." }),
      run({ status: 'done', content: 'Landed; releasing.', continuation: true }),
      run({ status: 'done', content: 'Released 1.0.217 on every platform.', continuation: true }),
    ];
    assert.equal(outcomeOf({ status: 'running', messages: waitedThrough, durangoDispatch: dispatch }), null, 'still Working');
    assert.deepEqual(outcomeOf({ status: 'done', messages: waitedThrough, durangoDispatch: dispatch }), {
      outcome: 'finished',
      summary: 'Released 1.0.217 on every platform.',
      seq: 6,
    });
    // A turn that ended with a background command it did not wait on: a waiting report (odd seq).
    const early = [run({ status: 'done', content: 'Watching for the amend.' }), shells()];
    assert.deepEqual(outcomeOf({ status: 'done', messages: early, durangoDispatch: dispatch }), {
      outcome: 'finished',
      summary: 'Watching for the amend.',
      waiting: ['background command: watch the change for a new commit'],
      seq: 1,
    });
    assert.deepEqual(outcomeOf({ status: 'done', messages: [early[0], shells('stopping')], durangoDispatch: dispatch }).waiting, ['background command: watch the change for a new commit'], 'still stopping');
    // Waiting on the person (request_user_action) is waiting too.
    assert.deepEqual(
      outcomeOf({ status: 'done', messages: [run({ status: 'done', content: 'Sign in, please.' })], userActions: [{ id: 'ua_1', action: 'Finish  the npm login', requestedAt: 'x' }], durangoDispatch: dispatch }).waiting,
      ['the person: Finish the npm login']
    );
    const reportedWaiting = { ...dispatch, reportedAt: 'x', reportedSeq: 1 };
    assert.equal(outcomeOf({ status: 'done', messages: early, durangoDispatch: reportedWaiting }), null, 'that wait was reported');
    // The wait ended (the command finished, was stopped, or the app quit) with no turn after it: reported once more.
    for (const status of ['settled', 'stopped']) {
      const ended = outcomeOf({ status: 'done', messages: [early[0], shells(status)], durangoDispatch: reportedWaiting });
      assert.equal(ended.outcome, 'finished');
      assert.equal(ended.waitEnded, true);
      assert.equal(ended.seq, 2);
      assert.match(ended.summary, /^The background work it was waiting on has ended .* Its last words:\n\nWatching for the amend\.$/s);
    }
    const longEnd = outcomeOf({ status: 'done', messages: [run({ status: 'done', content: 'OPENING ' + 'x'.repeat(5_000) + ' THE END' }), shells('settled')], durangoDispatch: reportedWaiting });
    assert.ok(longEnd.summary.startsWith('The background work') && longEnd.summary.includes('OPENING') && longEnd.summary.endsWith('THE END') && longEnd.summary.length <= 4_000, 'clips the middle of the words, keeps note, opening and end');
    // ...or the thread resumed by itself, and that turn reports when it settles.
    const resumed = [early[0], shells('settled'), run({ status: 'running', continuation: true })];
    assert.equal(outcomeOf({ status: 'running', messages: resumed, durangoDispatch: reportedWaiting }), null, 'resumed turn still running');
    resumed[2] = { ...resumed[2], status: 'done', content: 'Landed all three.' };
    assert.deepEqual(outcomeOf({ status: 'done', messages: resumed, durangoDispatch: reportedWaiting }), { outcome: 'finished', summary: 'Landed all three.', seq: 4 });
    assert.equal(outcomeOf({ status: 'done', messages: resumed, durangoDispatch: { ...reportedWaiting, reportedSeq: 4 } }), null, 'that turn already reported');
    resumed[2] = { ...resumed[2], status: 'error', error: 'claude exited with code 1.' };
    assert.deepEqual(outcomeOf({ status: 'error', messages: resumed, durangoDispatch: reportedWaiting }), { outcome: 'failed', error: 'claude exited with code 1.', seq: 4 });
    // A steer splits one run in two: the second half (continuation) is the outcome.
    const steered = [run({ status: 'done', content: 'Halfway.', statusText: 'Steered' }), { id: 's', role: 'user', content: 'also do X', ts: 'x', steer: true }, run({ status: 'stopped', continuation: true })];
    assert.match(outcomeOf({ status: 'idle', messages: steered, durangoDispatch: dispatch }).error, /Stopped in Durango Code/);
    // A turn the person sent ends the dispatch's chain: theirs isn't reported.
    const personTurn = [run({ status: 'done', content: 'Done.' }), run({ status: 'done', content: 'Their own question.' }), run({ status: 'done', content: 'More of theirs.', continuation: true })];
    assert.equal(outcomeOf({ status: 'done', messages: personTurn, durangoDispatch: { ...dispatch, reportedAt: 'x', reportedSeq: 2 } }), null);
    // Reported by an older build (no reportedSeq): never again.
    assert.equal(outcomeOf({ status: 'done', messages: waitedThrough, durangoDispatch: { ...dispatch, reportedAt: 'x' } }), null);
    // The cheap shell check agrees.
    assert.equal(durangoDispatchHasNewRuns(dispatch, 0), true);
    assert.equal(durangoDispatchHasNewRuns({ ...dispatch, reportedAt: 'x' }, 9), false);
    assert.equal(durangoDispatchHasNewRuns({ ...dispatch, reportedAt: 'x', reportedSeq: 2 }, 1), false);
    assert.equal(durangoDispatchHasNewRuns({ ...dispatch, reportedAt: 'x', reportedSeq: 2 }, 2), true);
    assert.equal(durangoDispatchHasNewRuns(reportedWaiting, 1), true, 'a reported wait can end without a new run');
  });
  // A small store and clock for the reporter (App.tsx mounts it on the real store).
  const reporterWorld = ({ settle }) => {
    let state = { threads: [], transcripts: {} };
    const listeners = new Set();
    let clock = 0;
    const timers = [];
    const sent = [];
    const set = (patch) => {
      const previous = state;
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener(state, previous);
    };
    const thread = (id, fields) => ({ id, status: 'done', summary: { agentRunCount: 0 }, ...fields });
    const putThread = (next) => set({ threads: [...state.threads.filter((t) => t.id !== next.id), next] });
    const stop = startDurangoDispatchReporter({
      getState: () => state,
      subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      ensureTranscript: async () => null,
      settle: (input) => {
        sent.push(input);
        return settle(input);
      },
      markReported: (threadId, dispatchId, reported) => {
        const current = state.threads.find((t) => t.id === threadId);
        if (current?.durangoDispatch?.id === dispatchId) putThread({ ...current, durangoDispatch: { ...current.durangoDispatch, ...reported } });
      },
      setTimer: (callback, ms) => {
        const timer = { at: clock + ms, callback };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => timers.splice(timers.indexOf(timer), 1),
      now: () => clock,
    });
    const tick = async (ms) => {
      clock += ms;
      for (const timer of timers.filter((t) => t.at <= clock)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { get state() { return state; }, set, thread, putThread, sent, tick, stop };
  };
  const agentRun = (fields) => ({ id: `m${Math.random()}`, role: 'agent', kind: 'agent-run', content: '', ts: 'x', ...fields });
  const card = (status) => ({
    id: 'card', role: 'system', kind: 'claude-background-intervention', content: '', ts: 'x',
    claudeBackgroundIntervention: { runId: 'r', tasks: ['watch'], status },
  });

  await test('reporter: a turn that settles while the previous report is in flight is still reported', async () => {
    let release;
    const world = reporterWorld({ settle: () => new Promise((resolve) => (release = resolve)) });
    const dispatch = { id: 'localbot:b:t', sourceUrl: null, startedAt: 'x' };
    const first = agentRun({ status: 'done', content: 'Watching.' });
    world.set({ transcripts: { t1: { messages: [first, card('pending')] } } });
    world.putThread(world.thread('t1', { durangoDispatch: dispatch, summary: { agentRunCount: 1 } }));
    assert.equal(world.sent.length, 1);
    assert.deepEqual(world.sent[0].waiting, ['background command: watch']);
    // The thread resumes and finishes before the first report is acknowledged.
    world.set({ transcripts: { t1: { messages: [first, card('settled'), agentRun({ status: 'done', content: 'Released.', continuation: true })] } } });
    world.putThread(world.thread('t1', { durangoDispatch: dispatch, summary: { agentRunCount: 2 } }));
    assert.equal(world.sent.length, 1, 'one report at a time');
    release({ ok: true });
    await world.tick(0);
    await world.tick(0);
    assert.equal(world.sent.length, 2);
    assert.equal(world.sent[1].summary, 'Released.');
    assert.equal(world.sent[1].seq, 4);
    world.stop();
  });

  await test('reporter: an undelivered report is tried again, and only marked once delivered', async () => {
    const answers = [{ ok: false, retry: true }, { ok: true }];
    const world = reporterWorld({ settle: async () => answers.shift() });
    const dispatch = { id: 'disp_1', sourceUrl: null, startedAt: 'x' };
    world.set({ transcripts: { t1: { messages: [agentRun({ status: 'done', content: 'Done.' })] } } });
    world.putThread(world.thread('t1', { durangoDispatch: dispatch, summary: { agentRunCount: 1 } }));
    await world.tick(0);
    assert.equal(world.sent.length, 1);
    assert.equal(world.state.threads[0].durangoDispatch.reportedAt, undefined, 'not marked while undelivered');
    await world.tick(60_000);
    await world.tick(0);
    assert.equal(world.sent.length, 2);
    assert.equal(world.state.threads[0].durangoDispatch.reportedSeq, 2);
    world.stop();
  });

  await test('reporter: a wait that ends with no turn after it reports after a grace period; a resumed turn does not', async () => {
    const world = reporterWorld({ settle: async () => ({ ok: true }) });
    const dispatch = { id: 'bottask:x', sourceUrl: null, startedAt: 'x', reportedAt: 'x', reportedSeq: 1 };
    const first = agentRun({ status: 'done', content: 'Watching.' });
    world.set({ transcripts: { t1: { messages: [first, card('pending')] } } });
    world.putThread(world.thread('t1', { durangoDispatch: dispatch, summary: { agentRunCount: 1 } }));
    assert.equal(world.sent.length, 0, 'still waiting');
    // The card settles (only the transcript changes): not yet.
    world.set({ transcripts: { t1: { messages: [first, card('settled')] } } });
    assert.equal(world.sent.length, 0, 'grace period');
    // A resumed turn shows up within the grace period: no "wait ended" report.
    world.set({ transcripts: { t1: { messages: [first, card('settled'), agentRun({ status: 'running', continuation: true })] } } });
    world.putThread(world.thread('t1', { status: 'running', durangoDispatch: dispatch, summary: { agentRunCount: 2 } }));
    await world.tick(10_000);
    assert.equal(world.sent.length, 0);
    world.stop();

    // No turn follows: reported once the grace period is over.
    const quiet = reporterWorld({ settle: async () => ({ ok: true }) });
    quiet.set({ transcripts: { t1: { messages: [first, card('settled')] } } });
    quiet.putThread(quiet.thread('t1', { durangoDispatch: dispatch, summary: { agentRunCount: 1 } }));
    assert.equal(quiet.sent.length, 0);
    await quiet.tick(5_100);
    await quiet.tick(0);
    assert.equal(quiet.sent.length, 1);
    assert.equal(quiet.sent[0].seq, 2);
    assert.equal(quiet.sent[0].waitEnded, undefined, 'not sent to main');
    assert.match(quiet.sent[0].summary, /^The background work it was waiting on has ended/);
    assert.equal(quiet.state.threads[0].durangoDispatch.reportedSeq, 2);
    quiet.stop();
  });

  // --- Notices: a running bot thread that needs the person or looks stuck -----
  const noticesWorld = ({ pending = async () => [], notice = () => ({ ok: true }), runMessageId } = {}) => {
    let state = { threads: [], transcripts: {} };
    const listeners = new Set();
    const eventListeners = new Set();
    let clock = 1_000_000;
    const timers = [];
    const sent = [];
    const set = (patch) => {
      const previous = state;
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener(state, previous);
    };
    const stop = startDurangoDispatchNotices({
      getState: () => state,
      subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      onTurnEvent: (listener) => (eventListeners.add(listener), () => eventListeners.delete(listener)),
      pendingInput: (threadId) => pending(threadId),
      ...(runMessageId ? { runMessageId } : {}),
      notice: (input) => {
        sent.push(input);
        return notice(input);
      },
      setTimer: (callback, ms) => {
        const timer = { at: clock + ms, callback };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => timers.splice(timers.indexOf(timer), 1),
      now: () => clock,
    });
    const flush = async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const tick = async (ms) => {
      const until = clock + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        clock = due.at;
        due.callback();
        await flush();
      }
      clock = until;
      await flush();
    };
    const emit = async (event) => {
      for (const listener of [...eventListeners]) listener(event);
      await flush();
    };
    return { get state() { return state; }, set, sent, tick, emit, stop, flush, get clock() { return clock; } };
  };
  const botThread = (fields = {}) => ({
    id: 't1', status: 'running', summary: { agentRunCount: 1 },
    durangoDispatch: { id: 'bottask:task1', sourceUrl: null, startedAt: 'x' }, ...fields,
  });
  const iso = (ms) => new Date(ms).toISOString();
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
  };
  // An approval card as main lists it (claude-input.js: approvalView + the generic card).
  const approvalCard = (fields = {}) => ({
    requestId: 'req-1', runId: 'run-1', threadId: 't1',
    approval: {
      toolName: 'Bash', title: 'Claude wants to run a command',
      reason: "Claude Code can't be sure it read this command the way the shell will, so it can't rule out a dangerous removal. Read the command, and don't go ahead if you can't tell what it does.",
      command: 'cd ~/repo; for w in a b; do git -C ~/.durango/ws/$w add -AN .; done',
    },
    detail: 'Compare workspaces\n\ncd ~/repo; for w in a b; do git -C ~/.durango/ws/$w add -AN .; done',
    questions: [{ id: 'permission', header: 'Bash', question: 'Claude wants to run a command', options: [{ label: 'Allow once' }, { label: 'Deny' }] }],
    ...fields,
  });

  await test('notices: the live dispatched run, not the person\'s own turn', () => {
    const run = agentRun({ status: 'running' });
    assert.equal(durangoDispatchLiveRun(botThread(), [run]), run);
    assert.equal(durangoDispatchLiveRun(botThread({ status: 'idle' }), [run]), null);
    const resumed = agentRun({ status: 'running', continuation: true });
    assert.equal(durangoDispatchLiveRun(botThread(), [agentRun({ status: 'done' }), resumed]), resumed);
    assert.deepEqual(durangoDispatchLiveRunAt(botThread(), [agentRun({ status: 'done' }), resumed]), { run: resumed, position: 1 });
    const theirs = agentRun({ status: 'running' });
    assert.equal(durangoDispatchLiveRun(botThread(), [agentRun({ status: 'done' }), { id: 'u', role: 'user', content: 'mine', ts: 'x' }, theirs]), null);
    assert.equal(durangoDispatchLiveRun({ status: 'running' }, [run]), null);
  });

  await test('notices: an approval card on a bot thread goes to its bot at once, with the tool and why, never the call (the 85-minute release thread)', async () => {
    let cards = [];
    const world = noticesWorld({ pending: async () => cards });
    const run = agentRun({ status: 'running', startedAt: iso(1_000_000), activities: [] });
    world.set({ threads: [botThread()], transcripts: { t1: { messages: [run] } } });
    await world.tick(0);
    assert.equal(world.sent.length, 0, 'nothing pending yet');
    cards = [approvalCard()];
    await world.emit({ threadId: 't1', type: 'user-input' });
    assert.equal(world.sent.length, 1);
    assert.deepEqual({ ...world.sent[0], detail: undefined }, { dispatchId: 'bottask:task1', threadId: 't1', kind: 'input', key: 'input:req-1', seq: 2, detail: undefined });
    assert.match(world.sent[0].detail, /approve a Bash call/);
    assert.match(world.sent[0].detail, /Why it asked: Claude Code can't be sure it read this command/);
    assert.doesNotMatch(world.sent[0].detail, /git -C|durango\/ws|Compare workspaces/, 'no part of the call leaves the machine');
    // Seen again (another event, the periodic look): sent once.
    await world.emit({ threadId: 't1', type: 'user-input' });
    await world.tick(5 * 60_000);
    assert.equal(world.sent.length, 1);
    // Waiting on the person is not "stuck", however long it lasts.
    await world.tick(2 * DISPATCH_STUCK_AFTER_MS);
    assert.equal(world.sent.filter((n) => n.kind === 'stuck').length, 0);
    world.stop();
  });

  await test('notices: an approval for a call that carries a secret sends none of it', () => {
    // Shaped like a live Stripe key (built at runtime so it reads as no secret here).
    const secret = ['sk', 'live', '51Hx9QaZ7Rk2PdVtYw3mNcB8'].join('_');
    const request = approvalCard({
      approval: {
        toolName: 'mcp__stripe__create_refund', title: `Claude wants to call create_refund with api_key ${secret}`,
        reason: `Approve the refund with key ${secret}?`,
        input: JSON.stringify({ api_key: secret, charge: 'ch_3PqR' }, null, 2), purpose: 'Refund the charge',
      },
      detail: `Refund the charge\n\n${JSON.stringify({ api_key: secret, charge: 'ch_3PqR' })}`,
      questions: [{ id: 'permission', header: 'create_refund', question: `Claude wants to call create_refund with api_key ${secret}` }],
    });
    const text = pendingInputText(request);
    assert.match(text, /approve a create_refund call/);
    assert.ok(!text.includes(secret), text);
    assert.ok(!text.includes('ch_3PqR'), text);
    assert.equal(safeApprovalReason(request), '', 'a reason that repeats the call is left out');
    assert.equal(safeApprovalReason(approvalCard({ approval: { toolName: 'Bash', command: 'rm -rf build', reason: "Command argument 'build' uses a provider path" } })), "Command argument 'build' uses a provider path", 'short pieces are not matched');
    assert.equal(safeApprovalReason(approvalCard({ approval: { toolName: 'Bash', command: 'cat /etc/secrets.env', reason: "Path '/etc/secrets.env' resolves near a sensitive file" } })), '');
    assert.equal(safeApprovalReason(approvalCard({ approval: { toolName: 'Bash', command: 'ls', reason: 'Hook says no.\nSecond line' } })), 'Hook says no. Second line');
  });

  await test('notices: questions and request_user_action reach the bot; async questions and other threads don\'t', async () => {
    const world = noticesWorld({
      pending: async (threadId) => threadId === 't1'
        ? [
            { requestId: 7, threadId, questions: [{ id: '0', header: 'Deploy', question: 'Which environment?', options: [{ label: 'staging' }, { label: 'prod' }] }] },
            { requestId: 8, threadId, async: true, questions: [{ id: '0', header: 'Later', question: 'Anything else?' }] },
          ]
        : [{ requestId: 9, threadId, questions: [{ id: '0', header: 'Q', question: 'Mine?' }] }],
    });
    const run = agentRun({ status: 'running', startedAt: iso(1_000_000) });
    const own = { id: 't2', status: 'running', summary: { agentRunCount: 1 } };
    world.set({ threads: [botThread(), own], transcripts: { t1: { messages: [run] }, t2: { messages: [agentRun({ status: 'running' })] } } });
    await world.emit({ threadId: 't1', type: 'user-input' });
    await world.emit({ threadId: 't2', type: 'user-input' });
    assert.deepEqual(world.sent.map((n) => n.key), ['input:7']);
    assert.match(world.sent[0].detail, /Which environment\? \(options: staging \/ prod\)/);
    world.set({ threads: [botThread({ userActions: [{ id: 'ua_1', action: 'Sign in to npm', url: 'https://www.npmjs.com/login?next=%2Fsettings%2Ftokens&token=abc123', requestedAt: 'x' }] }), own] });
    await world.tick(0);
    assert.deepEqual(world.sent.map((n) => n.key), ['input:7', 'action:ua_1']);
    assert.equal(world.sent[1].detail, 'It asked the person to: Sign in to npm\nhttps://www.npmjs.com/login', 'the page, without its query');
    assert.equal(userActionText({ action: 'Plug in the phone', url: 'javascript:alert(1)' }), 'It asked the person to: Plug in the phone');
    world.stop();
  });

  await test('notices: a request from another run, or read while the run changed, is not sent', async () => {
    // The request's run (main's run id) writes to another run message.
    const world = noticesWorld({ pending: async () => [approvalCard({ runId: 'old-run' })], runMessageId: (runId) => (runId === 'old-run' ? 'm-old' : undefined) });
    const run = agentRun({ id: 'm-live', status: 'running', startedAt: iso(1_000_000) });
    world.set({ threads: [botThread()], transcripts: { t1: { messages: [run] } } });
    await world.emit({ threadId: 't1', type: 'user-input' });
    assert.equal(world.sent.length, 0);
    world.stop();
    // The list was read for the dispatched run; by the time it came back the person had started their own turn.
    const read = deferred();
    const raced = noticesWorld({ pending: () => read.promise });
    const dispatched = agentRun({ id: 'm-a', status: 'running', startedAt: iso(1_000_000) });
    raced.set({ threads: [botThread()], transcripts: { t1: { messages: [dispatched] } } });
    await raced.emit({ threadId: 't1', type: 'user-input' });
    raced.set({ transcripts: { t1: { messages: [{ ...dispatched, status: 'done' }, { id: 'u', role: 'user', content: 'mine', ts: 'x' }, agentRun({ id: 'm-b', status: 'running' })] } } });
    read.resolve([approvalCard()]);
    await raced.flush();
    assert.equal(raced.sent.length, 0);
    raced.stop();
  });

  await test('notices: a request that arrives during a pending-list read is read right after it; "stuck" waits for the fresh list', async () => {
    const reads = [];
    const world = noticesWorld({
      pending: () => {
        const read = deferred();
        reads.push(read);
        return read.promise;
      },
    });
    const run = agentRun({ id: 'run1', status: 'running', startedAt: iso(1_000_000), activities: [] });
    world.set({ threads: [botThread()], transcripts: { t1: { messages: [run] } } });
    await world.emit({ threadId: 't1', type: 'user-input' });
    assert.equal(reads.length, 1, 'the first look reads the list');
    // A card appears (user-input) while that read is still out: not lost.
    await world.emit({ threadId: 't1', type: 'user-input' });
    assert.equal(reads.length, 1, 'one read at a time');
    reads[0].resolve([]);
    await world.flush();
    assert.equal(reads.length, 2, 'read again right after');
    reads[1].resolve([approvalCard()]);
    await world.flush();
    assert.deepEqual(world.sent.map((n) => n.key), ['input:req-1']);
    world.stop();

    // Quiet for 15 minutes, and the card shows up just as the periodic look runs:
    // the look waits for the list, so no "looks stuck" goes out for a thread waiting on the person.
    const later = [];
    const quiet = noticesWorld({
      pending: () => {
        const read = deferred();
        later.push(read);
        return read.promise;
      },
    });
    quiet.set({ threads: [botThread()], transcripts: { t1: { messages: [agentRun({ id: 'run2', status: 'running', startedAt: iso(1_000_000), activities: [] })] } } });
    for (let minute = 1; minute < 15; minute += 1) {
      await quiet.tick(60_000);
      later.shift().resolve([]);
      await quiet.flush();
    }
    await quiet.tick(60_000);
    assert.equal(quiet.sent.length, 0, 'nothing before the fresh list is in');
    later.shift().resolve([approvalCard({ requestId: 'req-2' })]);
    await quiet.flush();
    assert.deepEqual(quiet.sent.map((n) => n.kind), ['input']);
    quiet.stop();
  });

  await test('notices: a quiet bot thread reports "looks stuck" once per quiet stretch, without the step\'s arguments', async () => {
    const world = noticesWorld();
    const run = agentRun({ id: 'run1', status: 'running', startedAt: iso(1_000_000), content: 'Comparing the workspaces.', activities: [] });
    world.set({ threads: [botThread()], transcripts: { t1: { messages: [run] } } });
    await world.tick(DISPATCH_STUCK_AFTER_MS - 60_000);
    assert.equal(world.sent.length, 0, 'not yet');
    await world.tick(60_000);
    assert.equal(world.sent.length, 1);
    assert.equal(world.sent[0].kind, 'stuck');
    assert.equal(world.sent[0].seq, 2);
    assert.match(world.sent[0].detail, /No progress for 15 minutes/);
    assert.match(world.sent[0].detail, /waiting on the model/);
    assert.match(world.sent[0].detail, /Comparing the workspaces/);
    await world.tick(DISPATCH_STUCK_AFTER_MS);
    assert.equal(world.sent.length, 1, 'once for this quiet stretch');
    // Progress, then quiet again: a new stretch.
    await world.emit({ threadId: 't1', type: 'chunk' });
    await world.tick(DISPATCH_STUCK_AFTER_MS + 60_000);
    assert.equal(world.sent.length, 2);
    assert.notEqual(world.sent[1].key, world.sent[0].key);
    world.stop();
    const busy = noticesWorld();
    const command = { id: 'c', type: 'command', title: 'Command - curl -H "Authorization: Bearer tok_123456789" https://api', detail: 'curl …', toolName: 'Bash', status: 'running', ts: iso(1_000_000) };
    busy.set({ threads: [botThread()], transcripts: { t1: { messages: [agentRun({ status: 'running', startedAt: iso(1_000_000), activities: [command] })] } } });
    await busy.tick(DISPATCH_STUCK_AFTER_MS + 60_000);
    assert.match(busy.sent[0].detail, /The step in progress: a shell command/);
    assert.doesNotMatch(busy.sent[0].detail, /tok_123456789|curl/);
    busy.stop();

    // Stuck notice prefers the latest message after earlier tool calls and trims the middle if long.
    const narrating = noticesWorld();
    const earlier = 'Earlier progress line that should not appear.\n\n';
    const latest = 'Latest status: ' + 'w'.repeat(500) + ' waiting on deploy.';
    narrating.set({
      threads: [botThread()],
      transcripts: {
        t1: {
          messages: [
            agentRun({
              id: 'run-narr',
              status: 'running',
              startedAt: iso(1_000_000),
              content: `${earlier}${latest}`,
              activities: [{ id: 'a1', type: 'command', title: 'step', status: 'done', ts: iso(1_000_000), contentOffset: earlier.length }],
            }),
          ],
        },
      },
    });
    await narrating.tick(DISPATCH_STUCK_AFTER_MS + 60_000);
    assert.doesNotMatch(narrating.sent[0].detail, /Earlier progress line/);
    assert.match(narrating.sent[0].detail, /Its last words so far: Latest status:/);
    assert.match(narrating.sent[0].detail, /waiting on deploy\.$/);
    assert.match(narrating.sent[0].detail, /…\[middle trimmed\]…/);
    narrating.stop();
  });

  await test('notices: no "looks stuck" while it waits on what it started itself (Claude and Codex step shapes)', async () => {
    const tool = (title, fields = {}) => ({ id: title, type: 'tool', title, status: 'running', ts: iso(1_000_000), ...fields });
    assert.equal(runWaitsOnItself(agentRun({ status: 'done', statusText: 'Waiting on 1 background task…' })), true);
    assert.equal(runWaitsOnItself(agentRun({ status: 'running', activities: [tool('Tool - mcp__orion__wait_for_background_tasks')] })), true);
    assert.equal(runWaitsOnItself(agentRun({ status: 'running', activities: [tool('Tool - Agent')] })), true);
    assert.equal(runWaitsOnItself(agentRun({ status: 'running', activities: [tool('Tool - Monitor')] })), true);
    assert.equal(runWaitsOnItself(agentRun({ status: 'running', activities: [{ ...tool('Tool - Agent'), status: 'done' }] })), false);
    assert.equal(runWaitsOnItself(agentRun({ status: 'running', activities: [{ id: 'c', type: 'command', title: 'Command - git diff', status: 'running', ts: 'x' }] })), false);
    // Claude: the step as the driver builds it from the SDK's tool_use block.
    const [claudeStep] = extractActivitiesFromJsonEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__orion__machine_run_agent', input: { machine: 'omarchy', prompt: 'Build it' } }] },
    });
    assert.equal(claudeStep.toolName, 'mcp__orion__machine_run_agent');
    assert.equal(activityToolName(claudeStep), 'machine_run_agent');
    assert.equal(runWaitsOnItself(agentRun({ status: 'running', activities: [{ ...claudeStep, id: 'a', ts: iso(1_000_000) }] })), true);
    // Codex (codex-driver.js mcpToolCall): `Tool - orion.machine_run_agent`, toolName `orion.machine_run_agent`.
    const codexStep = tool('Tool - orion.machine_run_agent', { toolName: 'orion.machine_run_agent' });
    assert.equal(activityToolName(codexStep), 'machine_run_agent');
    assert.equal(runWaitsOnItself(agentRun({ status: 'running', activities: [codexStep] })), true);
    // A Codex step saved before steps carried toolName: read from its title.
    assert.equal(runWaitsOnItself(agentRun({ status: 'running', activities: [tool('Tool - orion.machine_run_agent')] })), true);
    assert.equal(runWaitsOnItself(agentRun({ status: 'running', activities: [tool('Tool - orion.wait_for_background_tasks')] })), true);
    assert.equal(runWaitsOnItself(agentRun({ status: 'running', activities: [tool('Tool - orion.browser_click', { toolName: 'orion.browser_click' })] })), false);
    const world = noticesWorld();
    world.set({
      threads: [botThread()],
      transcripts: { t1: { messages: [agentRun({ status: 'done', startedAt: iso(1_000_000), statusText: 'Waiting on 2 background tasks…' })] } },
    });
    await world.tick(3 * DISPATCH_STUCK_AFTER_MS);
    assert.equal(world.sent.length, 0);
    world.stop();
    const codexWait = noticesWorld();
    codexWait.set({ threads: [botThread()], transcripts: { t1: { messages: [agentRun({ status: 'running', startedAt: iso(1_000_000), activities: [codexStep] })] } } });
    await codexWait.tick(3 * DISPATCH_STUCK_AFTER_MS);
    assert.equal(codexWait.sent.length, 0, 'a Codex thread waiting on machine_run_agent is not stuck');
    codexWait.stop();
  });

  await test('notices: an undelivered notice is sent again only while it still holds', async () => {
    let fail = true;
    const world = noticesWorld({ notice: () => (fail ? { ok: false, retry: true } : { ok: true }) });
    world.set({ threads: [botThread({ userActions: [{ id: 'ua_1', action: 'Approve the deploy', requestedAt: 'x' }] })], transcripts: { t1: { messages: [agentRun({ status: 'running', startedAt: iso(1_000_000) })] } } });
    await world.tick(0);
    assert.equal(world.sent.length, 1);
    fail = false;
    await world.tick(2 * 60_000 + 1);
    assert.equal(world.sent.length, 2, 'tried again');
    await world.tick(10 * 60_000);
    assert.equal(world.sent.length, 2, 'delivered: once');
    world.stop();
    // Answered before the retry: never sent again.
    let cards = [approvalCard()];
    const answered = noticesWorld({ pending: async () => cards, notice: () => ({ ok: false, retry: true }) });
    answered.set({ threads: [botThread()], transcripts: { t1: { messages: [agentRun({ status: 'running', startedAt: iso(1_000_000) })] } } });
    await answered.emit({ threadId: 't1', type: 'user-input' });
    assert.equal(answered.sent.length, 1);
    cards = [];
    await answered.tick(5 * 60_000);
    assert.equal(answered.sent.length, 1, 'the person answered it: not resent');
    answered.stop();
    const idle = noticesWorld();
    idle.set({ threads: [{ id: 'x', status: 'running', summary: { agentRunCount: 1 } }], transcripts: { x: { messages: [agentRun({ status: 'running' })] } } });
    await idle.tick(3 * DISPATCH_STUCK_AFTER_MS);
    assert.equal(idle.sent.length, 0);
    idle.stop();
  });

  await test('notices: pendingInputText describes approvals and questions', () => {
    assert.match(pendingInputText({ requestId: 1, questions: [{ id: 'permission', header: 'Write', question: 'Allow Claude to use Write?' }] }), /^It is waiting for the person to approve a Write call in the thread/);
    assert.match(pendingInputText({ requestId: 1, questions: [{ id: '0', header: 'H', question: 'Ship it?' }] }), /^It asked the person:\n- Ship it\?$/);
  });

  await test('dispatch worker: notice posts to the dispatch\'s notice route with the thread, machine and run number; one attempt', async () => {
    const notices = (id) => server.requests.filter((request) => request.path === `/api/v1/code/dispatches/${id}/notice`).map((request) => request.body);
    server.on('POST', '/api/v1/code/dispatches/disp_n/notice', () => ({ json: { ok: true } }));
    const { worker } = makeWorker();
    const result = await worker.notice({ dispatchId: 'disp_n', threadId: 'thread-9', kind: 'input', key: 'input:r1', seq: 2, detail: 'It asked the person: x' });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(notices('disp_n').at(-1), {
      machineId: 'device-uuid-1',
      notice: { kind: 'input', key: 'input:r1', seq: 2, detail: 'It asked the person: x' },
      codeThreadId: 'thread-9',
    });
    assert.equal(reports('disp_n').length, 0, 'never on the report route');
    server.on('POST', '/api/v1/code/dispatches/disp_n/notice', () => ({ json: { ok: true, stale: true } }));
    assert.deepEqual(await worker.notice({ dispatchId: 'disp_n', threadId: 'thread-9', kind: 'input', key: 'input:r2', seq: 2, detail: 'd' }), { ok: true, stale: true });
    const before = notices('disp_n').length;
    server.on('POST', '/api/v1/code/dispatches/disp_n/notice', () => ({ status: 503, json: { error: { message: 'down' } } }));
    assert.equal((await worker.notice({ dispatchId: 'disp_n', threadId: 'thread-9', kind: 'stuck', key: 's', seq: 2, detail: 'd' })).retry, true);
    assert.equal(notices('disp_n').length, before + 1, 'one attempt: the renderer resends only if it still holds');
    server.on('POST', '/api/v1/code/dispatches/disp_n/notice', () => ({ status: 404, json: { error: { message: 'Not found' } } }));
    assert.deepEqual(await worker.notice({ dispatchId: 'disp_n', threadId: 'thread-9', kind: 'stuck', key: 's', seq: 2, detail: 'd' }), { ok: false }, 'a Durango without notices: final');
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
