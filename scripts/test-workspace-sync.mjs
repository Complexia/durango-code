// End-to-end check for the workspace sync engine (src/main/workspace-sync.js)
// against a local Orion Web dev stack (orion-next dev server + docker infra).
// Drives the real engine with mocked deps: fixture store/threads data, a
// signed desktop_session JWT, and a real temp git repo so the auto-publish
// code path runs the actual pack-objects → presigned-PUT pipeline.
//
//   ORION_NEXT_DIR=../orion-web/orion-next node scripts/test-workspace-sync.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  configureWorkspaceSync,
  getWorkspaceSyncStatus,
  initWorkspaceSync,
  workspaceSyncNow,
} from '../src/main/workspace-sync.js';

const orionNextDir = process.env.ORION_NEXT_DIR;
if (!orionNextDir) {
  throw new Error('Set ORION_NEXT_DIR to the related orion-next checkout (see the header comment).');
}
const BASE_URL = new URL(process.env.ORION_WEB_URL ?? 'http://localhost:3000');
const OWNER = 'user_desktop_e2e';

const envFile = fs.readFileSync(path.join(orionNextDir, '.env.local'), 'utf-8');
const secret = /^ORION_DESKTOP_AUTH_SECRET=(.+)$/m.exec(envFile)?.[1];
if (!secret) throw new Error('ORION_DESKTOP_AUTH_SECRET not found in orion-next/.env.local');

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const message = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
  kind: 'desktop_session',
  sub: OWNER,
  user: { id: OWNER, email: 'e2e@example.com', name: 'Desktop E2E', imageUrl: null },
  iat: now,
  exp: now + 3600,
})}`;
const token = `${message}.${crypto.createHmac('sha256', secret).update(message).digest('base64url')}`;

// Real git repo for the code-sync path.
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-e2e-repo-'));
const git = (...args) => execFileSync('git', args, { cwd: repoDir });
git('init', '-b', 'main');
git('config', 'user.email', 'e2e@example.com');
git('config', 'user.name', 'E2E');
fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n');
git('add', '.');
git('commit', '-m', 'initial');

const storeState = {
  projects: [
    { id: 'proj-git', name: 'E2E Git Project', path: repoDir },
    { id: 'proj-plain', name: 'Plain Folder', path: '/tmp/does-not-exist-orion-e2e' },
  ],
};

const threadsData = {
  threads: [
    {
      id: 'thread-claude',
      projectId: 'proj-git',
      title: 'Claude thread',
      status: 'done',
      modelId: 'claude:claude-fable-5',
      createdAt: '2026-07-25T00:00:00Z',
      messages: [
        { id: 'u1', role: 'user', content: 'do the thing', ts: '2026-07-25T00:00:00Z' },
        {
          id: 'a1',
          role: 'agent',
          kind: 'agent-run',
          content: 'done part 1',
          ts: '2026-07-25T00:01:00Z',
          modelId: 'claude:claude-fable-5',
          activities: [{ id: 'act1', type: 'tool', kind: 'execute', title: 'npm test', output: 'ok', ts: '2026-07-25T00:00:30Z' }],
          stats: { totalTokens: 1000, inputTokens: 800, outputTokens: 200, cachedReadTokens: 500 },
        },
        {
          id: 'a2',
          role: 'agent',
          kind: 'agent-run',
          content: 'done part 2',
          ts: '2026-07-25T00:02:00Z',
          completedAt: '2026-07-25T00:03:00Z',
          modelId: 'claude:claude-fable-5',
          stats: { totalTokens: 2000, inputTokens: 1500, outputTokens: 500, cachedReadTokens: 900 },
        },
      ],
    },
    {
      id: 'thread-codex',
      projectId: 'proj-git',
      title: 'Codex thread (cumulative stats)',
      status: 'done',
      modelId: 'codex:gpt-5.6-sol',
      createdAt: '2026-07-26T00:00:00Z',
      messages: [
        { id: 'u1', role: 'user', content: 'hi', ts: '2026-07-26T00:00:00Z' },
        {
          id: 'a1',
          role: 'agent',
          kind: 'agent-run',
          content: 'turn 1',
          ts: '2026-07-26T00:01:00Z',
          modelId: 'codex:gpt-5.6-sol',
          stats: { totalTokens: 3000, inputTokens: 2500, outputTokens: 500, modelId: 'gpt-5.6-sol' },
        },
        {
          id: 'a2',
          role: 'agent',
          kind: 'agent-run',
          content: 'turn 2',
          ts: '2026-07-26T00:02:00Z',
          completedAt: '2026-07-26T00:04:00Z',
          modelId: 'codex:gpt-5.6-sol',
          // Cumulative: this already includes turn 1.
          stats: { totalTokens: 5000, inputTokens: 4200, outputTokens: 800, modelId: 'gpt-5.6-sol' },
        },
      ],
    },
  ],
};

const assert = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${label}`);
  }
};

initWorkspaceSync({
  getWebUrl: () => BASE_URL,
  readSession: async () => ({ token, user: { id: OWNER } }),
  readStoreState: async () => storeState,
  readThreadsIndex: async () => ({
    entries: threadsData.threads.map((thread) => ({
      id: thread.id,
      hash: crypto.createHash('sha256').update(JSON.stringify(thread)).digest('hex'),
    })),
  }),
  readThreadsByIds: async (ids) =>
    threadsData.threads.filter((thread) => ids.includes(thread.id)),
  broadcast: () => {},
});

configureWorkspaceSync({ enabled: true, syncCode: true });
await workspaceSyncNow();

const status = getWorkspaceSyncStatus();
console.log('status:', JSON.stringify(status, null, 2));
assert(status.lastError === null, `sync pass had no error (got: ${status.lastError})`);
assert(status.backfillDone === true, 'backfill completed');
assert(status.counts?.threads === 2, 'two threads synced');
assert(status.counts?.transcriptsUploaded === 2, 'two transcripts uploaded');
assert(status.counts?.codePushes === 1, 'git project auto-published');

// The auto-publish must have linked the repo locally.
const linkedRepoId = execFileSync('git', ['config', '--local', 'orion.cloudrepoid'], { cwd: repoDir })
  .toString()
  .trim();
assert(Boolean(linkedRepoId), `repo linked to cloud repo (${linkedRepoId})`);

// Server-side verification via the sync state endpoint.
const state = await (
  await fetch(new URL('/api/sync/state', BASE_URL), {
    headers: { authorization: `Bearer ${token}` },
  })
).json();
assert(state.projects.length === 2, 'server has 2 projects');
assert(
  state.threads.length === 2 && state.threads.every((thread) => thread.transcriptHash),
  'server confirmed both transcripts'
);

// Second pass with unchanged data must be a no-op for transcripts.
await workspaceSyncNow();
const status2 = getWorkspaceSyncStatus();
assert(status2.counts?.transcriptsUploaded === 2, 'unchanged threads skipped on second pass');
assert(status2.lastError === null, 'second pass clean');

// Dirty working-tree changes are not repository save points and must not push.
fs.writeFileSync(path.join(repoDir, 'file2.txt'), 'more\n');
await workspaceSyncNow();
const dirtyStatus = getWorkspaceSyncStatus();
assert(dirtyStatus.counts?.codePushes === 1, 'uncommitted change did not auto-push');

// New commit → one code push on the next pass.
git('add', '.');
git('commit', '-m', 'second');
await workspaceSyncNow();
const status3 = getWorkspaceSyncStatus();
assert(status3.counts?.codePushes === 2, 'new commit auto-pushed');

console.log(process.exitCode ? '\nFAILURES above.' : '\nAll desktop sync engine checks passed.');
