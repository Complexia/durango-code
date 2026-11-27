// Global process-level error handlers for Electron's main process.
// Without these, an unhandled rejection (e.g. an unawaited driver startup) or
// stray uncaught exception terminates the main process immediately, bypassing
// `will-quit`, persistence flushes, and child-process cleanup.

export const UNCAUGHT_BURST_LIMIT = 10;
export const UNCAUGHT_BURST_WINDOW_MS = 10_000;

const formatValue = (value) => {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return '[unprintable error]';
  }
};

const isBrokenPipe = (error) => error?.code === 'EPIPE';

/**
 * Installs `uncaughtException`, `unhandledRejection`, and stdio `EPIPE` error
 * handlers on `processRef` so main-process errors are logged cleanly instead of
 * taking the app down or spinning on broken stdio pipes.
 *
 * If a non-EPIPE `uncaughtException` fires before `isReadyToStayAlive()` is
 * true (startup failure with no window) or repeats in a tight burst
 * (`burstLimit` within `burstWindowMs`), `onFatal` is invoked once so the
 * caller can trigger a graceful `app.quit()` instead of leaving a headless
 * zombie holding the single-instance lock.
 *
 * Returns a function that removes all installed listeners.
 */
export function installProcessErrorHandlers({
  processRef = process,
  log = console,
  onError,
  onFatal,
  isReadyToStayAlive = () => true,
  burstLimit = UNCAUGHT_BURST_LIMIT,
  burstWindowMs = UNCAUGHT_BURST_WINDOW_MS,
  now = Date.now,
} = {}) {
  let handling = false;
  let stdioBroken = false;
  let fatalTriggered = false;
  const recentUncaught = [];

  const safeReport = (label, value, payload, { skipLog = false } = {}) => {
    if (handling) return;
    handling = true;
    try {
      if (!skipLog && !stdioBroken) {
        try {
          log.error(label, formatValue(value));
        } catch (logError) {
          if (isBrokenPipe(logError)) stdioBroken = true;
          // Ignore logging errors so the error handler itself cannot recurse.
        }
      }
      if (typeof onError === 'function') {
        try {
          onError(payload);
        } catch {
          // Never let an observer throw out of a process error handler.
        }
      }
    } finally {
      handling = false;
    }
  };

  const maybeTriggerFatal = (payload) => {
    if (fatalTriggered || typeof onFatal !== 'function') return;
    fatalTriggered = true;
    try {
      onFatal(payload);
    } catch {
      // Never throw out of a process error handler.
    }
  };

  const onStdioError = (streamName) => (error) => {
    stdioBroken = true;
    if (isBrokenPipe(error)) return;
    safeReport(`[main] ${streamName} error:`, error, {
      type: 'stdioError',
      stream: streamName,
      error,
    }, { skipLog: true });
  };

  const onStdoutError = onStdioError('stdout');
  const onStderrError = onStdioError('stderr');

  const onUncaughtException = (error, origin) => {
    if (handling) return;

    const suffix = typeof origin === 'string' && origin ? ` (${origin})` : '';
    safeReport(`[main] Uncaught exception${suffix}:`, error, {
      type: 'uncaughtException',
      error,
      origin: origin ?? null,
    });

    if (isBrokenPipe(error)) return;

    if (!isReadyToStayAlive()) {
      maybeTriggerFatal({
        type: 'uncaughtException',
        reason: 'before-ready',
        error,
        origin: origin ?? null,
      });
      return;
    }

    const at = now();
    while (recentUncaught.length > 0 && at - recentUncaught[0] > burstWindowMs) {
      recentUncaught.shift();
    }
    recentUncaught.push(at);
    if (recentUncaught.length >= burstLimit) {
      maybeTriggerFatal({
        type: 'uncaughtException',
        reason: 'burst',
        error,
        origin: origin ?? null,
      });
    }
  };

  const onUnhandledRejection = (reason, promise) => {
    safeReport('[main] Unhandled promise rejection:', reason, {
      type: 'unhandledRejection',
      reason,
      promise,
    });
  };

  processRef.on('uncaughtException', onUncaughtException);
  processRef.on('unhandledRejection', onUnhandledRejection);
  processRef.stdout?.on?.('error', onStdoutError);
  processRef.stderr?.on?.('error', onStderrError);

  return () => {
    processRef.removeListener('uncaughtException', onUncaughtException);
    processRef.removeListener('unhandledRejection', onUnhandledRejection);
    processRef.stdout?.removeListener?.('error', onStdoutError);
    processRef.stderr?.removeListener?.('error', onStderrError);
  };
}
