// Global process-level error handlers for Electron's main process.
// Without these, an unhandled rejection (e.g. an unawaited driver startup) or
// stray uncaught exception terminates the main process immediately, bypassing
// `will-quit`, persistence flushes, and child-process cleanup.

const formatValue = (value) => {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return '[unprintable error]';
  }
};

/**
 * Installs `uncaughtException` and `unhandledRejection` handlers on `processRef`
 * so main-process errors are logged cleanly instead of taking the app down.
 * Returns a function that removes both listeners.
 */
export function installProcessErrorHandlers({
  processRef = process,
  log = console,
  onError,
} = {}) {
  let handling = false;

  const safeReport = (label, value, payload) => {
    if (handling) return;
    handling = true;
    try {
      try {
        log.error(label, formatValue(value));
      } catch {
        // Ignore logging errors (e.g. EPIPE when a launching terminal closes)
        // so the error handler itself cannot recurse into another exception.
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

  const onUncaughtException = (error, origin) => {
    const suffix = typeof origin === 'string' && origin ? ` (${origin})` : '';
    safeReport(`[main] Uncaught exception${suffix}:`, error, {
      type: 'uncaughtException',
      error,
      origin: origin ?? null,
    });
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

  return () => {
    processRef.removeListener('uncaughtException', onUncaughtException);
    processRef.removeListener('unhandledRejection', onUnhandledRejection);
  };
}
