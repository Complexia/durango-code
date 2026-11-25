// Opt-in workspace sync consent: migration rules, opt-in dialog markup,
// settings copy, and sync engine opt-in / immediate-stop guarantees.
//
//   bun scripts/test-workspace-sync-consent.tsx
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  WORKSPACE_SYNC_CONSENT_VERSION,
  defaultWorkspaceSyncConsentSettings,
  migrateWorkspaceSyncSettings,
  shouldShowWorkspaceSyncConsentPrompt,
} from '../src/app/workspaceSyncConsent';
import { WorkspaceSyncConsentDialog } from '../src/app/WorkspaceSyncConsentDialog';
import {
  configureWorkspaceSync,
  getWorkspaceSyncStatus,
  initWorkspaceSync,
  notifyAccountChanged,
  notifyWorkspaceChanged,
  shutdownWorkspaceSync,
  workspaceSyncNow,
} from '../src/main/workspace-sync.js';

// 1. Defaults and migration rules.
assert.equal(WORKSPACE_SYNC_CONSENT_VERSION, 2);
assert.deepEqual(defaultWorkspaceSyncConsentSettings, {
  enabled: false,
  syncCode: false,
  consentVersion: 2,
  consentNoticeSeen: false,
});

// Fresh install / null / corrupt object -> both off, prompt once signed in.
for (const input of [undefined, null, {} as never]) {
  const migrated = migrateWorkspaceSyncSettings(input);
  assert.deepEqual(migrated, defaultWorkspaceSyncConsentSettings);
  assert.equal(shouldShowWorkspaceSyncConsentPrompt(migrated, false), false);
  assert.equal(shouldShowWorkspaceSyncConsentPrompt(migrated, true), true);
}

// Consent v1 users switched on by merge migration (whether or not they dismissed the notice) -> off + prompt once.
for (const seen of [false, true]) {
  for (const syncCode of [false, true]) {
    const migrated = migrateWorkspaceSyncSettings({
      enabled: true,
      syncCode,
      consentVersion: 1,
      consentNoticeSeen: seen,
    });
    assert.deepEqual(migrated, {
      enabled: false,
      syncCode: false,
      consentVersion: 2,
      consentNoticeSeen: false,
    });
    assert.equal(shouldShowWorkspaceSyncConsentPrompt(migrated, true), true);
  }
}

// Consent v1 user who explicitly turned sharing off -> stays off, no re-prompt.
const v1Off = migrateWorkspaceSyncSettings({
  enabled: false,
  syncCode: true,
  consentVersion: 1,
  consentNoticeSeen: true,
});
assert.deepEqual(v1Off, {
  enabled: false,
  syncCode: false,
  consentVersion: 2,
  consentNoticeSeen: true,
});
assert.equal(shouldShowWorkspaceSyncConsentPrompt(v1Off, true), false);

// Pre-Durango explicit opt-in -> preserved without prompting.
const preDurangoOn = migrateWorkspaceSyncSettings({ enabled: true, syncCode: true });
assert.deepEqual(preDurangoOn, {
  enabled: true,
  syncCode: true,
  consentVersion: 2,
  consentNoticeSeen: true,
});
assert.equal(shouldShowWorkspaceSyncConsentPrompt(preDurangoOn, true), false);

// Pre-Durango default off -> stays off, syncCode off, prompt once when signed in.
const preDurangoOff = migrateWorkspaceSyncSettings({ enabled: false, syncCode: true });
assert.deepEqual(preDurangoOff, {
  enabled: false,
  syncCode: false,
  consentVersion: 2,
  consentNoticeSeen: false,
});
assert.equal(shouldShowWorkspaceSyncConsentPrompt(preDurangoOff, true), true);

// Consent v2 choices are idempotent and preserve syncCode independently.
for (const state of [
  { enabled: false, syncCode: false, consentVersion: 2, consentNoticeSeen: true },
  { enabled: true, syncCode: false, consentVersion: 2, consentNoticeSeen: true },
  { enabled: true, syncCode: true, consentVersion: 2, consentNoticeSeen: true },
]) {
  assert.deepEqual(migrateWorkspaceSyncSettings(state), state);
  assert.equal(shouldShowWorkspaceSyncConsentPrompt(state, true), false);
}

// 2. Opt-in consent dialog markup: clear disclosure, separate unchecked code sync, equal choices.
const dialogHtml = renderToStaticMarkup(
  <WorkspaceSyncConsentDialog onDecline={() => {}} onAccept={() => {}} />
);
assert.match(dialogHtml, /role="dialog"/);
assert.match(dialogHtml, /aria-modal="true"/);
assert.match(dialogHtml, /data-testid="workspace-sync-consent-dialog"/);
assert.match(dialogHtml, /Share coding work with Durango\?/);
assert.match(dialogHtml, /full transcripts/);
assert.match(dialogHtml, /token usage/);
assert.match(dialogHtml, /Durango Chat memory/);
assert.match(dialogHtml, /Usage history on durango\.sh/);
assert.match(dialogHtml, /Durango Source profile stats/);
assert.match(dialogHtml, /data-testid="workspace-sync-consent-code-toggle"/);
assert.doesNotMatch(
  dialogHtml,
  /data-testid="workspace-sync-consent-code-toggle"[^>]*checked/,
  'code sync checkbox must be unchecked by default'
);
assert.match(dialogHtml, /grid-cols-2/, 'Not now and Turn on sharing are equal-width choices');
assert.match(dialogHtml, /data-testid="workspace-sync-consent-decline"[^>]*>Not now<\/button>/);
assert.match(dialogHtml, /data-testid="workspace-sync-consent-accept"[^>]*>Turn on sharing<\/button>/);

// 3. Settings page and App wiring checks.
const srcDir = new URL('../src', import.meta.url).pathname;
const [settingsSource, appSource] = await Promise.all([
  fs.readFile(path.join(srcDir, 'app/SettingsPage.tsx'), 'utf8'),
  fs.readFile(path.join(srcDir, 'App.tsx'), 'utf8'),
]);
const cloudSyncStart = settingsSource.indexOf("{settingsTab === 'cloud-sync' && (");
const generalStart = settingsSource.indexOf("{settingsTab === 'general' && (", cloudSyncStart);
assert.ok(cloudSyncStart > 0 && generalStart > cloudSyncStart, 'found cloud-sync settings tab');
const cloudSyncSection = settingsSource.slice(cloudSyncStart, generalStart);
assert.doesNotMatch(
  cloudSyncSection,
  /Share coding work with Durango[\s\S]{0,400}On by default/,
  'Share coding work setting must not say On by default'
);
assert.match(cloudSyncSection, /Share coding work with Durango[\s\S]{0,300}Off by default/);
assert.match(cloudSyncSection, /Sync code to Durango Cloud[\s\S]{0,300}Off by default/);
assert.match(cloudSyncSection, /Durango Source\s+profile stats/);
assert.match(appSource, /<WorkspaceSyncConsentDialog/);
assert.doesNotMatch(appSource, /WorkspaceSyncNotice/);

// 4. Sync engine: off by default, syncCode off by default even when enabled, immediate stop on disable.
const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-sync-consent-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir });
git('init', '-b', 'main');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
await fs.writeFile(path.join(repoDir, 'README.md'), '# test\n');
git('add', '.');
git('commit', '-m', 'init');

const requests: string[] = [];
let holdStateRequest: (() => void) | null = null;
let stateAborted = false;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  requests.push(`${options?.method ?? 'GET'} ${url.pathname}`);
  if (url.pathname === '/api/sync/state') {
    if (holdStateRequest) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          stateAborted = true;
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (options?.signal?.aborted) return onAbort();
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        holdStateRequest = () => {
          options?.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
      });
    }
    return new Response(JSON.stringify({ threads: [] }), { status: 200 });
  }
  if (url.pathname === '/api/sync/snapshot') return new Response(JSON.stringify({ ok: true, removals: true }), { status: 200 });
  if (url.pathname === '/api/sync/threads') return new Response(JSON.stringify({ uploads: [] }), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

try {
  initWorkspaceSync({
    getWebUrl: () => 'https://durango.test',
    readSession: async () => ({ token: 'tok', user: { id: 'user_1' } }),
    readStoreState: async () => ({
      projects: [{ id: 'p1', name: 'Repo', path: repoDir }],
    }),
    readThreadsIndex: async () => ({ version: 3, entries: [] }),
    readThreadsForSync: async () => [],
    broadcast: () => {},
  });

  // Before enabling, sync is completely inert.
  notifyWorkspaceChanged();
  await workspaceSyncNow();
  assert.deepEqual(requests, [], 'no network requests while workspace sync is off');
  assert.equal(getWorkspaceSyncStatus().enabled, false);

  // Enabling sharing without syncCode leaves code sync off (no /api/git/* calls).
  configureWorkspaceSync({ enabled: true });
  await workspaceSyncNow();
  assert.ok(requests.some((req) => req.includes('/api/sync/state')), 'metadata sync ran when enabled');
  assert.ok(
    !requests.some((req) => req.includes('/api/git/')),
    'syncCode stays off by default even when enabled is passed without syncCode'
  );

  // Turning sharing off mid-pass aborts the in-flight request immediately and stops all syncing.
  configureWorkspaceSync({ enabled: false });
  notifyAccountChanged();
  requests.length = 0;
  stateAborted = false;
  holdStateRequest = () => {};
  configureWorkspaceSync({ enabled: true, syncCode: false });
  const pendingPass = workspaceSyncNow();
  // Let the pass enter /api/sync/state.
  await new Promise((resolve) => setTimeout(resolve, 25));
  configureWorkspaceSync({ enabled: false, syncCode: false });
  await pendingPass;
  assert.equal(stateAborted, true, 'turning sharing off aborts an in-flight sync immediately');
  assert.equal(getWorkspaceSyncStatus().enabled, false);
  assert.equal(getWorkspaceSyncStatus().syncing, false);

  requests.length = 0;
  notifyWorkspaceChanged();
  await workspaceSyncNow();
  assert.deepEqual(requests, [], 'no further sync requests after turning sharing off');
} finally {
  holdStateRequest = null;
  configureWorkspaceSync({ enabled: false, syncCode: false });
  shutdownWorkspaceSync();
  globalThis.fetch = originalFetch;
  await fs.rm(repoDir, { recursive: true, force: true });
}

console.log('workspace sync consent tests passed');
