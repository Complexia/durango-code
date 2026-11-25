// Opt-in workspace sync consent: migration rules, opt-in dialog markup,
// settings copy, startup seeding guard, and sync engine opt-in / immediate-stop
// guarantees (including mid-pass code-sync disable).
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

// Fresh install / null / empty object -> both off, prompt once signed in.
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

// Consent v1 with missing `enabled` -> treated as switched on by v1, reset to off + prompt once.
assert.deepEqual(
  migrateWorkspaceSyncSettings({ consentVersion: 1 } as never),
  { enabled: false, syncCode: false, consentVersion: 2, consentNoticeSeen: false }
);

// Consent v1 user who explicitly turned sharing off (regardless of notice flag) -> stays off, no re-prompt.
for (const seen of [false, true]) {
  const v1Off = migrateWorkspaceSyncSettings({
    enabled: false,
    syncCode: true,
    consentVersion: 1,
    consentNoticeSeen: seen,
  });
  assert.deepEqual(v1Off, {
    enabled: false,
    syncCode: false,
    consentVersion: 2,
    consentNoticeSeen: true,
  });
  assert.equal(shouldShowWorkspaceSyncConsentPrompt(v1Off, true), false);
}

// Pre-Durango explicit opt-in -> preserved without prompting; missing syncCode stays false.
assert.deepEqual(migrateWorkspaceSyncSettings({ enabled: true, syncCode: true }), {
  enabled: true,
  syncCode: true,
  consentVersion: 2,
  consentNoticeSeen: true,
});
assert.deepEqual(migrateWorkspaceSyncSettings({ enabled: true }), {
  enabled: true,
  syncCode: false,
  consentVersion: 2,
  consentNoticeSeen: true,
});
assert.equal(
  shouldShowWorkspaceSyncConsentPrompt(migrateWorkspaceSyncSettings({ enabled: true }), true),
  false
);

// Pre-Durango default off -> stays off, syncCode off, prompt once when signed in.
const preDurangoOff = migrateWorkspaceSyncSettings({ enabled: false, syncCode: true });
assert.deepEqual(preDurangoOff, {
  enabled: false,
  syncCode: false,
  consentVersion: 2,
  consentNoticeSeen: false,
});
assert.equal(shouldShowWorkspaceSyncConsentPrompt(preDurangoOff, true), true);

// Corrupt or stringified consentVersion values normalize safely.
assert.deepEqual(
  migrateWorkspaceSyncSettings({ enabled: true, syncCode: true, consentVersion: Number.NaN }),
  { enabled: true, syncCode: true, consentVersion: 2, consentNoticeSeen: true }
);
assert.deepEqual(
  migrateWorkspaceSyncSettings({ enabled: false, syncCode: true, consentVersion: -1 }),
  { enabled: false, syncCode: false, consentVersion: 2, consentNoticeSeen: false }
);
assert.deepEqual(
  migrateWorkspaceSyncSettings({ enabled: true, syncCode: true, consentVersion: '1' as unknown as number }),
  { enabled: false, syncCode: false, consentVersion: 2, consentNoticeSeen: false }
);
assert.deepEqual(
  migrateWorkspaceSyncSettings({ enabled: true, syncCode: false, consentVersion: '2' as unknown as number, consentNoticeSeen: true }),
  { enabled: true, syncCode: false, consentVersion: 2, consentNoticeSeen: true }
);

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

// 3. Settings page, App, dialog, and main.js wiring checks.
const srcDir = new URL('../src', import.meta.url).pathname;
const [settingsSource, appSource, dialogSource, mainSource, storeSource] = await Promise.all([
  fs.readFile(path.join(srcDir, 'app/SettingsPage.tsx'), 'utf8'),
  fs.readFile(path.join(srcDir, 'App.tsx'), 'utf8'),
  fs.readFile(path.join(srcDir, 'app/WorkspaceSyncConsentDialog.tsx'), 'utf8'),
  fs.readFile(path.join(srcDir, 'main.js'), 'utf8'),
  fs.readFile(path.join(srcDir, 'store.ts'), 'utf8'),
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
assert.match(
  cloudSyncSection,
  /e\.target\.checked \? \{\} : \{ syncCode: false \}/,
  'turning sharing off resets syncCode so re-enabling does not silently resume code sync'
);
assert.match(
  cloudSyncSection,
  /checked=\{workspaceSyncSettings\.enabled && workspaceSyncSettings\.syncCode\}/,
  'disabled code sync toggle reflects off when sharing is off'
);
assert.match(appSource, /<WorkspaceSyncConsentDialog/);
assert.match(
  appSource,
  /whatsNew\?\.unseen && !showWorkspaceSyncConsentPrompt/,
  'WhatsNewNotice waits for the consent dialog instead of stealing focus'
);
assert.doesNotMatch(appSource, /WorkspaceSyncNotice/);
assert.match(
  dialogSource,
  /querySelectorAll\('\[aria-modal="true"\]'\)/,
  'consent dialog yields keyboard handling when a higher modal is open'
);
assert.match(
  mainSource,
  /workspaceSyncConfigureSeq === 0 && state\?\.workspaceSyncSettings/,
  'main startup seeding cannot overwrite a live renderer sync:configure call'
);
assert.doesNotMatch(
  storeSource,
  /cloud\/docs\/workspace-sync\.md/,
  'public code/ tree does not reference private monorepo paths'
);

// 4. Sync engine: off by default, syncCode off by default even when enabled,
//    immediate stop on disable, and clean mid-pass code-sync cancellation.
const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-sync-consent-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir });
git('init', '-b', 'main');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
await fs.writeFile(path.join(repoDir, 'README.md'), '# test\n');
git('add', '.');
git('commit', '-m', 'init');

const requests: string[] = [];
let holdStateRequest = false;
let holdGitRequest = false;
let failGitRequest = false;
let stateAborted = false;
let gitAborted = false;
let onGitRequestEntered: (() => void) | null = null;
let onStateRequestEntered: (() => void) | null = null;

const waitForAbort = (signal: AbortSignal | null | undefined, onAbortFlag: () => void) =>
  new Promise<never>((_resolve, reject) => {
    const abort = () => {
      onAbortFlag();
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  requests.push(`${options?.method ?? 'GET'} ${url.pathname}`);
  if (url.pathname === '/api/sync/state') {
    if (holdStateRequest) {
      onStateRequestEntered?.();
      await waitForAbort(options?.signal, () => {
        stateAborted = true;
      });
    }
    return new Response(JSON.stringify({ threads: [] }), { status: 200 });
  }
  if (url.pathname === '/api/sync/snapshot') {
    return new Response(JSON.stringify({ ok: true, removals: true }), { status: 200 });
  }
  if (url.pathname === '/api/sync/threads') {
    return new Response(JSON.stringify({ uploads: [] }), { status: 200 });
  }
  if (url.pathname === '/api/git/repos') {
    if (holdGitRequest) {
      onGitRequestEntered?.();
      await waitForAbort(options?.signal, () => {
        gitAborted = true;
      });
    }
    if (failGitRequest) {
      return new Response(JSON.stringify({ error: 'Repo publish rejected.' }), { status: 500 });
    }
  }
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
  holdStateRequest = true;
  const enteredState = new Promise<void>((resolve) => {
    onStateRequestEntered = resolve;
  });
  configureWorkspaceSync({ enabled: true, syncCode: false });
  const pendingPass = workspaceSyncNow();
  await enteredState;
  configureWorkspaceSync({ enabled: false, syncCode: false });
  await pendingPass;
  holdStateRequest = false;
  onStateRequestEntered = null;
  assert.equal(stateAborted, true, 'turning sharing off aborts an in-flight sync immediately');
  assert.equal(getWorkspaceSyncStatus().enabled, false);
  assert.equal(getWorkspaceSyncStatus().syncing, false);

  requests.length = 0;
  notifyWorkspaceChanged();
  await workspaceSyncNow();
  assert.deepEqual(requests, [], 'no further sync requests after turning sharing off');

  // Turning syncCode ON while sharing is already on triggers code sync, and a failure shows in lastError;
  // turning syncCode OFF clears the stale code-sync error immediately while keeping sharing on.
  configureWorkspaceSync({ enabled: true, syncCode: false });
  await workspaceSyncNow();
  requests.length = 0;
  failGitRequest = true;
  configureWorkspaceSync({ enabled: true, syncCode: true });
  await workspaceSyncNow();
  failGitRequest = false;
  assert.ok(
    requests.some((req) => req.includes('/api/git/repos')),
    'enabling syncCode while sharing is on runs code sync'
  );
  assert.match(getWorkspaceSyncStatus().lastError ?? '', /Repo publish rejected/);
  configureWorkspaceSync({ enabled: true, syncCode: false });
  assert.equal(getWorkspaceSyncStatus().enabled, true);
  assert.equal(
    getWorkspaceSyncStatus().lastError,
    null,
    'disabling syncCode clears stale code-sync errors immediately'
  );

  // Turning syncCode OFF mid-pass aborts the code publish immediately WITHOUT losing
  // backfillDone / lastSyncAt / counts from the already-completed project & thread pass.
  configureWorkspaceSync({ enabled: false, syncCode: false });
  notifyAccountChanged();
  requests.length = 0;
  gitAborted = false;
  holdGitRequest = true;
  const enteredGit = new Promise<void>((resolve) => {
    onGitRequestEntered = resolve;
  });
  configureWorkspaceSync({ enabled: true, syncCode: true });
  const midCodePass = workspaceSyncNow();
  await enteredGit;
  configureWorkspaceSync({ enabled: true, syncCode: false });
  await midCodePass;
  holdGitRequest = false;
  onGitRequestEntered = null;
  const afterMidCodeAbort = getWorkspaceSyncStatus();
  assert.equal(gitAborted, true, 'turning syncCode off aborts the in-flight git publish immediately');
  assert.equal(afterMidCodeAbort.enabled, true);
  assert.equal(afterMidCodeAbort.syncing, false);
  assert.equal(afterMidCodeAbort.backfillDone, true, 'completed thread/project backfill is preserved');
  assert.ok(afterMidCodeAbort.lastSyncAt, 'lastSyncAt is recorded after clean code-only abort');
  assert.equal(afterMidCodeAbort.lastError, null, 'aborted code sync does not report an error');
  assert.equal(afterMidCodeAbort.counts?.projects, 1, 'project counts are preserved');
} finally {
  holdStateRequest = false;
  holdGitRequest = false;
  failGitRequest = false;
  configureWorkspaceSync({ enabled: false, syncCode: false });
  shutdownWorkspaceSync();
  globalThis.fetch = originalFetch;
  await fs.rm(repoDir, { recursive: true, force: true });
}

console.log('workspace sync consent tests passed');
