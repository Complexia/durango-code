import React from 'react';

export type FormattedErrorDetails = {
  summary: string;
  details: string;
};

export const formatErrorDetails = (
  error: unknown,
  componentStack?: string | null
): FormattedErrorDetails => {
  let name = 'Error';
  let message = 'An unexpected error occurred while rendering Durango Code.';
  let stack = '';

  if (error instanceof Error) {
    name = error.name || 'Error';
    message = error.message || message;
    stack = typeof error.stack === 'string' ? error.stack.trim() : '';
  } else if (typeof error === 'string' && error.trim()) {
    message = error.trim();
  } else if (error != null) {
    try {
      message = String(error);
    } catch {
      // Keep default message for unprintable values.
    }
  }

  const summary = message.startsWith(`${name}:`) ? message : `${name}: ${message}`;
  const sections: string[] = [stack || summary];
  const trimmedComponentStack = typeof componentStack === 'string' ? componentStack.trim() : '';
  if (trimmedComponentStack) {
    sections.push(`Component stack:\n${trimmedComponentStack}`);
  }

  return {
    summary,
    details: sections.join('\n\n'),
  };
};

export type AppCrashFallbackProps = {
  error: unknown;
  componentStack?: string | null;
  onReload: () => void;
  onRetry?: () => void;
  onCopy?: (details: string) => void | Promise<void>;
};

export const AppCrashFallback: React.FC<AppCrashFallbackProps> = ({
  error,
  componentStack,
  onReload,
  onRetry,
  onCopy,
}) => {
  const [copied, setCopied] = React.useState(false);
  const { summary, details } = formatErrorDetails(error, componentStack);

  const handleCopy = () => {
    setCopied(true);
    const copy =
      onCopy ??
      ((text: string) => {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          return navigator.clipboard.writeText(text);
        }
      });
    void Promise.resolve(copy(details)).catch(() => {});
    if (typeof window !== 'undefined') {
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="app-error-boundary"
      style={{
        minHeight: '100vh',
        width: '100vw',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'var(--bg-base, #101012)',
        color: 'var(--text-primary, #ececef)',
        fontFamily:
          'var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '580px',
          borderRadius: 'var(--radius-lg, 14px)',
          border: '1px solid var(--border-default, rgb(255 255 255 / 10%))',
          background: 'var(--bg-surface, #1d1d21)',
          boxShadow: 'var(--shadow-lg, 0 16px 48px rgb(0 0 0 / 42%))',
          padding: '24px',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: '8px',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: '10px',
              height: '10px',
              borderRadius: '9999px',
              background: 'var(--danger, #f87171)',
              flexShrink: 0,
            }}
          />
          <h1
            style={{
              margin: 0,
              fontSize: '17px',
              fontWeight: 700,
              lineHeight: 1.3,
              color: 'var(--text-primary, #ececef)',
            }}
          >
            Durango Code ran into an unexpected error
          </h1>
        </div>
        <p
          style={{
            margin: '0 0 16px 0',
            fontSize: '13px',
            lineHeight: 1.5,
            color: 'var(--text-secondary, #a0a0a8)',
          }}
        >
          Your threads and projects are saved on disk. Reload the window to recover.
        </p>

        <div
          data-testid="app-error-message"
          style={{
            marginBottom: '12px',
            padding: '10px 12px',
            borderRadius: 'var(--radius-sm, 6px)',
            border: '1px solid rgb(248 113 113 / 28%)',
            background: 'rgb(248 113 113 / 8%)',
            color: 'var(--danger, #f87171)',
            fontFamily:
              'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
            fontSize: '12px',
            lineHeight: 1.45,
            wordBreak: 'break-word',
          }}
        >
          {summary}
        </div>

        <details
          open
          style={{
            marginBottom: '18px',
            borderRadius: 'var(--radius-sm, 6px)',
            border: '1px solid var(--border-subtle, rgb(255 255 255 / 7%))',
            background: 'var(--bg-base, #101012)',
            padding: '8px 12px',
          }}
        >
          <summary
            style={{
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--text-secondary, #a0a0a8)',
              userSelect: 'none',
            }}
          >
            Error details
          </summary>
          <pre
            data-testid="app-error-details"
            style={{
              margin: '8px 0 0 0',
              maxHeight: '220px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily:
                'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
              fontSize: '11.5px',
              lineHeight: 1.5,
              color: 'var(--text-secondary, #a0a0a8)',
            }}
          >
            {details}
          </pre>
        </details>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            data-testid="app-error-copy"
            onClick={handleCopy}
            style={{
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm, 6px)',
              border: '1px solid var(--border-default, rgb(255 255 255 / 12%))',
              background: 'transparent',
              color: 'var(--text-secondary, #a0a0a8)',
              padding: '8px 14px',
              fontSize: '12.5px',
              fontWeight: 500,
            }}
          >
            {copied ? 'Copied' : 'Copy details'}
          </button>
          {onRetry && (
            <button
              type="button"
              data-testid="app-error-retry"
              onClick={onRetry}
              style={{
                cursor: 'pointer',
                borderRadius: 'var(--radius-sm, 6px)',
                border: '1px solid var(--border-default, rgb(255 255 255 / 12%))',
                background: 'var(--bg-hover, #303036)',
                color: 'var(--text-primary, #ececef)',
                padding: '8px 14px',
                fontSize: '12.5px',
                fontWeight: 500,
              }}
            >
              Try again
            </button>
          )}
          <button
            type="button"
            data-testid="app-error-reload"
            onClick={onReload}
            style={{
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm, 6px)',
              border: 0,
              background:
                'linear-gradient(135deg, var(--accent-strong, #3b7aed), var(--accent-deep, #2563eb))',
              color: 'var(--on-accent, #ffffff)',
              padding: '8px 16px',
              fontSize: '12.5px',
              fontWeight: 600,
            }}
          >
            Reload window
          </button>
        </div>
      </div>
    </div>
  );
};

export type AppErrorBoundaryProps = {
  children: React.ReactNode;
  onReload?: () => void;
  onError?: (error: Error, info: React.ErrorInfo) => void;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  error: unknown;
  componentStack: string | null;
};

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    hasError: false,
    error: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const componentStack = info?.componentStack ?? null;
    console.error('Durango Code renderer error:', error, componentStack ?? '');
    this.setState({ componentStack });
    this.props.onError?.(error, info);
  }

  private handleReload = () => {
    if (this.props.onReload) {
      this.props.onReload();
      return;
    }
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  private handleRetry = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <AppCrashFallback
          error={this.state.error}
          componentStack={this.state.componentStack}
          onReload={this.handleReload}
          onRetry={this.handleRetry}
        />
      );
    }
    return this.props.children;
  }
}
