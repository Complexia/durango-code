import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AppCrashFallback,
  AppErrorBoundary,
  formatErrorDetails,
} from '../src/app/AppErrorBoundary';
import { writeFileAtomic, writeFileAtomicSync } from '../src/main/atomic-write.js';
import { installProcessErrorHandlers } from '../src/main/process-error-handlers.js';

// 1. React ErrorBoundary & fallback UI
{
  const err = new TypeError('Cannot read properties of undefined (reading "id")');
  const formatted = formatErrorDetails(err, '\n    at Sidebar\n    at App');
  assert.match(formatted.summary, /TypeError: Cannot read properties of undefined/);
  assert.match(formatted.details, /Component stack:/);
  assert.match(formatted.details, /at Sidebar/);

  const nonError = formatErrorDetails('raw string failure');
  assert.equal(nonError.summary, 'Error: raw string failure');
  assert.equal(nonError.details, 'Error: raw string failure');

  // Normal children render through AppErrorBoundary untouched.
  const okHtml = renderToStaticMarkup(
    <AppErrorBoundary>
      <div data-testid="healthy-child">hello world</div>
    </AppErrorBoundary>
  );
  assert.match(okHtml, /data-testid="healthy-child"/);
  assert.match(okHtml, /hello world/);

  // Fallback screen renders fixed scrollable container, hardcoded high-contrast
  // colors (immune to broken custom theme vars), reload/retry/copy buttons, and error details.
  const fallbackHtml = renderToStaticMarkup(
    <AppCrashFallback
      error={err}
      componentStack={'\n    at ChatPane\n    at App'}
      onReload={() => {}}
      onRetry={() => {}}
    />
  );
  assert.match(fallbackHtml, /role="alert"/);
  assert.match(fallbackHtml, /data-testid="app-error-boundary"/);
  assert.match(fallbackHtml, /position:fixed/);
  assert.match(fallbackHtml, /overflow-y:auto/);
  assert.doesNotMatch(fallbackHtml, /var\(--/, 'fallback styling must not depend on custom theme CSS variables');
  assert.match(fallbackHtml, /data-testid="app-error-reload"/);
  assert.match(fallbackHtml, />Reload window<\/button>/);
  assert.match(fallbackHtml, /data-testid="app-error-retry"/);
  assert.match(fallbackHtml, /data-testid="app-error-copy"/);
  assert.match(fallbackHtml, /data-testid="app-error-message"/);
  assert.match(fallbackHtml, /data-testid="app-error-details"/);
  assert.match(fallbackHtml, /Cannot read properties of undefined/);
  assert.match(fallbackHtml, /at ChatPane/);

  // Lifecycle transitions: getDerivedStateFromError -> componentDidCatch -> retry / reload,
  // including stripping any injected custom theme style element.
  let reloaded = 0;
  let reported: { error: Error; stack: string } | null = null;
  const boundary = new AppErrorBoundary({
    children: <span>ok</span>,
    onReload: () => {
      reloaded += 1;
    },
    onError: (error, info) => {
      reported = { error, stack: info.componentStack ?? '' };
    },
  });
  const derived = AppErrorBoundary.getDerivedStateFromError(err);
  assert.equal(derived.hasError, true);
  assert.equal(derived.error, err);
  boundary.state = { ...boundary.state, ...derived };

  let lastStateUpdate: Record<string, unknown> | null = null;
  boundary.setState = ((partial: Record<string, unknown>) => {
    lastStateUpdate = partial;
    boundary.state = { ...boundary.state, ...partial };
  }) as typeof boundary.setState;

  const removedStyleIds: string[] = [];
  const removedClasses: string[] = [];
  const removedAttrs: string[] = [];
  const dataset: Record<string, string | undefined> = { theme: 'custom-broken' };
  const prevDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    getElementById: (id: string) =>
      id === 'durango-theme-style' || id === 'durango-theme-values'
        ? { remove: () => { removedStyleIds.push(id); } }
        : null,
    documentElement: {
      dataset,
      classList: {
        remove: (...names: string[]) => removedClasses.push(...names),
      },
      getAttributeNames: () => ['data-theme', 'data-tv-intensity', 'class'],
      removeAttribute: (name: string) => removedAttrs.push(name),
    },
  };

  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    boundary.componentDidCatch(err, { componentStack: '\n    at BrokenView' });
  } finally {
    console.error = originalConsoleError;
    if (prevDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = prevDocument;
  }
  assert.deepEqual(
    removedStyleIds.sort(),
    ['durango-theme-style', 'durango-theme-values'],
    'componentDidCatch must strip ThemeLayer style elements so broken themes cannot hide recovery UI'
  );
  assert.ok(removedClasses.includes('durango-themed'));
  assert.ok(removedClasses.includes('theme-light'));
  assert.equal(dataset.theme, undefined);
  assert.deepEqual(removedAttrs, ['data-tv-intensity']);
  assert.equal(logged.length, 1);
  assert.equal(reported?.error, err);
  assert.match(reported?.stack ?? '', /at BrokenView/);
  assert.equal(lastStateUpdate?.componentStack, '\n    at BrokenView');

  const renderedFallback = boundary.render() as React.ReactElement<{
    onReload: () => void;
    onRetry: () => void;
  }>;
  assert.equal(renderedFallback.type, AppCrashFallback);
  renderedFallback.props.onReload();
  assert.equal(reloaded, 1);
  renderedFallback.props.onRetry();
  assert.equal(boundary.state.hasError, false);
  assert.equal(boundary.state.error, null);
}

// 2. Main-process uncaughtException, unhandledRejection, stdio EPIPE, and fatal guard
{
  const makeFakeProcess = () =>
    Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

  const fakeProcess = makeFakeProcess();
  const logs: unknown[][] = [];
  const observed: unknown[] = [];
  const uninstall = installProcessErrorHandlers({
    processRef: fakeProcess,
    log: { error: (...args: unknown[]) => logs.push(args) },
    onError: (payload: unknown) => observed.push(payload),
  });

  const boom = new Error('unexpected main failure');
  fakeProcess.emit('uncaughtException', boom, 'uncaughtException');
  fakeProcess.emit('unhandledRejection', new Error('driver start failed'), Promise.resolve());

  assert.equal(logs.length, 2);
  assert.match(String(logs[0][0]), /Uncaught exception/);
  assert.match(String(logs[0][1]), /unexpected main failure/);
  assert.match(String(logs[1][0]), /Unhandled promise rejection/);
  assert.match(String(logs[1][1]), /driver start failed/);
  assert.equal(observed.length, 2);

  // Async EPIPE on stderr silences stdio logging and prevents an infinite uncaughtException spin.
  let logCallsAfterPipeBreak = 0;
  const epipeProcess = makeFakeProcess();
  const stopEpipe = installProcessErrorHandlers({
    processRef: epipeProcess,
    log: {
      error: () => {
        logCallsAfterPipeBreak += 1;
        // Simulate libuv emitting async EPIPE on stderr on the next microtask.
        queueMicrotask(() => {
          epipeProcess.stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        });
      },
    },
  });
  epipeProcess.emit('uncaughtException', new Error('first error'), 'uncaughtException');
  await new Promise((resolve) => setTimeout(resolve, 10));
  epipeProcess.emit('uncaughtException', new Error('second error after broken pipe'), 'uncaughtException');
  epipeProcess.emit('uncaughtException', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), 'uncaughtException');
  assert.equal(logCallsAfterPipeBreak, 1, 'once stderr emits EPIPE, further writes to broken stdio must stop');
  stopEpipe();

  // A non-stdio EPIPE (e.g. from a child-process stdin pipe or socket) is logged
  // without muting future error logs on healthy stdio or triggering onFatal.
  const childEpipeProcess = makeFakeProcess();
  const childEpipeLogs: unknown[][] = [];
  let childEpipeFatals = 0;
  const stopChildEpipe = installProcessErrorHandlers({
    processRef: childEpipeProcess,
    log: { error: (...args: unknown[]) => childEpipeLogs.push(args) },
    isReadyToStayAlive: () => false,
    onFatal: () => { childEpipeFatals += 1; },
  });
  childEpipeProcess.emit('uncaughtException', Object.assign(new Error('child pipe EPIPE'), { code: 'EPIPE' }), 'uncaughtException');
  childEpipeProcess.emit('unhandledRejection', new Error('subsequent rejection still logged'), Promise.resolve());
  assert.equal(childEpipeLogs.length, 2, 'child/socket EPIPE must not mute subsequent stdio error logs');
  assert.equal(childEpipeFatals, 0, 'EPIPE must not trigger fatal exit');
  stopChildEpipe();

  // Re-entrancy guard prevents synchronous recursion and avoids double-counting toward burstLimit/onFatal.
  let reentrantObserved = 0;
  let reentrantFatals = 0;
  const reentrantProcess = makeFakeProcess();
  const stopReentrant = installProcessErrorHandlers({
    processRef: reentrantProcess,
    log: { error: () => {} },
    burstLimit: 2,
    onFatal: () => { reentrantFatals += 1; },
    onError: () => {
      reentrantObserved += 1;
      if (reentrantObserved === 1) {
        reentrantProcess.emit('uncaughtException', new Error('nested'), 'uncaughtException');
      }
    },
  });
  reentrantProcess.emit('uncaughtException', new Error('outer'), 'uncaughtException');
  assert.equal(reentrantObserved, 1, 'synchronous re-entrant uncaughtException must be suppressed');
  assert.equal(reentrantFatals, 0, 'synchronous re-entrant uncaughtException must not increment burst counter');
  stopReentrant();

  // Broken stdout/stderr (synchronous throw) or throwing observer never crashes the handler.
  const brokenProcess = makeFakeProcess();
  const stopBroken = installProcessErrorHandlers({
    processRef: brokenProcess,
    log: {
      error: () => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
    },
    onError: () => {
      throw new Error('observer threw');
    },
  });
  assert.doesNotThrow(() => {
    brokenProcess.emit('uncaughtException', new Error('inner'), 'uncaughtException');
    brokenProcess.emit('unhandledRejection', 'rejected reason', Promise.resolve());
  });
  stopBroken();

  // Pre-window uncaughtException triggers onFatal once so startup failures don't leave a headless zombie.
  const startupProcess = makeFakeProcess();
  const fatals: Array<{ reason: string }> = [];
  const stopStartup = installProcessErrorHandlers({
    processRef: startupProcess,
    log: { error: () => {} },
    isReadyToStayAlive: () => false,
    onFatal: (payload: { reason: string }) => fatals.push(payload),
  });
  startupProcess.emit('uncaughtException', new Error('boot failure'), 'uncaughtException');
  startupProcess.emit('uncaughtException', new Error('second boot failure'), 'uncaughtException');
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].reason, 'before-ready');
  stopStartup();

  // Repeated post-startup uncaughtExceptions in a tight burst trigger onFatal once.
  const burstProcess = makeFakeProcess();
  const burstFatals: Array<{ reason: string }> = [];
  let clock = 1000;
  const stopBurst = installProcessErrorHandlers({
    processRef: burstProcess,
    log: { error: () => {} },
    isReadyToStayAlive: () => true,
    burstLimit: 3,
    burstWindowMs: 5_000,
    now: () => clock,
    onFatal: (payload: { reason: string }) => burstFatals.push(payload),
  });
  burstProcess.emit('uncaughtException', new Error('e1'), 'uncaughtException');
  clock += 100;
  burstProcess.emit('uncaughtException', new Error('e2'), 'uncaughtException');
  assert.equal(burstFatals.length, 0);
  clock += 100;
  burstProcess.emit('uncaughtException', new Error('e3'), 'uncaughtException');
  assert.equal(burstFatals.length, 1);
  assert.equal(burstFatals[0].reason, 'burst');
  stopBurst();

  // Uninstall removes process and stdio listeners cleanly.
  uninstall();
  assert.equal(fakeProcess.listenerCount('uncaughtException'), 0);
  assert.equal(fakeProcess.listenerCount('unhandledRejection'), 0);
  assert.equal(fakeProcess.stdout.listenerCount('error'), 0);
  assert.equal(fakeProcess.stderr.listenerCount('error'), 0);
}

// 3. Atomic file writes (async + sync, mode 0o600, durable fsync, win32 rename retry, failure cleanup, concurrency)
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-atomic-write-'));
  try {
    const nestedFile = path.join(tmpDir, 'nested', 'account-session.json');
    await writeFileAtomic(nestedFile, '{"token":"secret"}\n', {
      encoding: 'utf8',
      mode: 0o600,
      durable: true,
    });
    assert.equal(await fs.readFile(nestedFile, 'utf8'), '{"token":"secret"}\n');
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(nestedFile)).mode & 0o777, 0o600);
    }

    // Existing file with loose permissions is tightened atomically to 0o600.
    const looseFile = path.join(tmpDir, 'loose-session.json');
    await fs.writeFile(looseFile, '{"old":true}\n', { mode: 0o644 });
    await writeFileAtomic(looseFile, '{"new":true}\n', { encoding: 'utf8', mode: 0o600 });
    assert.equal(await fs.readFile(looseFile, 'utf8'), '{"new":true}\n');
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(looseFile)).mode & 0o777, 0o600);
    }

    // Sync atomic write with durable + mode works and leaves no temp files.
    const syncFile = path.join(tmpDir, 'sync-dir', 'store.json');
    writeFileAtomicSync(syncFile, '{"ok":1}', { encoding: 'utf8', mode: 0o600, durable: true });
    assert.equal(await fs.readFile(syncFile, 'utf8'), '{"ok":1}');
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(syncFile)).mode & 0o777, 0o600);
    }

    // Windows transient EPERM/EBUSY rename failures are retried (async + sync).
    const retryAsyncFile = path.join(tmpDir, 'win-retry-async.json');
    let asyncAttempts = 0;
    await writeFileAtomic(retryAsyncFile, '{"retried":true}', {
      platform: 'win32',
      sleepImpl: async () => {},
      renameImpl: async (from, to) => {
        asyncAttempts += 1;
        if (asyncAttempts < 3) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        await fs.rename(from, to);
      },
    });
    assert.equal(asyncAttempts, 3);
    assert.equal(await fs.readFile(retryAsyncFile, 'utf8'), '{"retried":true}');

    const retrySyncFile = path.join(tmpDir, 'win-retry-sync.json');
    let syncAttempts = 0;
    const { renameSync } = await import('node:fs');
    writeFileAtomicSync(retrySyncFile, '{"retriedSync":true}', {
      platform: 'win32',
      pauseImpl: () => {},
      renameImpl: (from, to) => {
        syncAttempts += 1;
        if (syncAttempts < 3) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        renameSync(from, to);
      },
    });
    assert.equal(syncAttempts, 3);
    assert.equal(await fs.readFile(retrySyncFile, 'utf8'), '{"retriedSync":true}');

    // Rename failure (target is a non-empty directory) cleans up its temp file.
    const blockerDir = path.join(tmpDir, 'dir-target');
    await fs.mkdir(blockerDir);
    await fs.writeFile(path.join(blockerDir, 'keep'), 'x');
    await assert.rejects(() => writeFileAtomic(blockerDir, 'data'));
    assert.throws(() => writeFileAtomicSync(blockerDir, 'data'));

    // Concurrent writes do not collide on temp names or leave .tmp files behind.
    const racingFile = path.join(tmpDir, 'racing.json');
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writeFileAtomic(racingFile, JSON.stringify({ index }))
      )
    );
    const finalParsed = JSON.parse(await fs.readFile(racingFile, 'utf8'));
    assert.equal(typeof finalParsed.index, 'number');

    const leftovers = [
      ...(await fs.readdir(tmpDir)),
      ...(await fs.readdir(path.join(tmpDir, 'nested'))),
      ...(await fs.readdir(path.join(tmpDir, 'sync-dir'))),
    ].filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'atomic writes must not leak .tmp files');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// 4. Wiring checks in renderer.tsx, main.js, and one-shot ACP drivers
{
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  const [rendererSource, mainSource, agySource, fxSource, kimiSource, themeLayerSource, boundarySource] = await Promise.all([
    fs.readFile(path.join(srcDir, 'renderer.tsx'), 'utf8'),
    fs.readFile(path.join(srcDir, 'main.js'), 'utf8'),
    fs.readFile(path.join(srcDir, 'main', 'antigravity-driver.js'), 'utf8'),
    fs.readFile(path.join(srcDir, 'main', 'fx-driver.js'), 'utf8'),
    fs.readFile(path.join(srcDir, 'main', 'kimi-driver.js'), 'utf8'),
    fs.readFile(path.join(srcDir, 'app', 'themes', 'ThemeLayer.tsx'), 'utf8'),
    fs.readFile(path.join(srcDir, 'app', 'AppErrorBoundary.tsx'), 'utf8'),
  ]);
  assert.match(rendererSource, /<AppErrorBoundary>[\s\S]*<App \/>[\s\S]*<\/AppErrorBoundary>/);
  assert.match(mainSource, /installProcessErrorHandlers\(\{/);
  assert.match(mainSource, /writeFileAtomic\(filePath,[\s\S]*?mode:\s*0o600[\s\S]*?durable:\s*true/);
  assert.match(mainSource, /Promise\.resolve\(acpDriver\.start\(\)\)\.catch\(/);
  assert.match(mainSource, /app\.whenReady\(\)\.then\([\s\S]*?\.catch\(/);
  assert.match(agySource, /Promise\.resolve\(driver\.start\(\)\)\.catch\(\(\) => finish\(false\)\)/);
  assert.match(fxSource, /Promise\.resolve\(driver\.start\(\)\)\.catch\(\(\) => finish\(false\)\)/);
  assert.match(kimiSource, /Promise\.resolve\(driver\.start\(\)\)\.catch\(\(\) => finish\(false\)\)/);
  // Keep AppErrorBoundary's cleared theme style IDs in sync with ThemeLayer.tsx.
  for (const [, styleId] of themeLayerSource.matchAll(/const (?:STYLE_ID|VALUES_STYLE_ID)\s*=\s*'([^']+)'/g)) {
    assert.ok(boundarySource.includes(`'${styleId}'`), `AppErrorBoundary must strip ThemeLayer style id '${styleId}'`);
  }
}

console.log('crash protection tests passed');
