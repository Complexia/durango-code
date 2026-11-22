import React, { useEffect, useState } from 'react';

// Finishes a provider sign-in whose browser step ends on a page showing a
// code (Antigravity: `agy acp --login`). The provider CLI waits for the code
// on stdin; main passes what the user pastes here and reports whether the CLI
// accepted it.
export const ProviderAuthCodePrompt: React.FC<{
  providerId: string;
  providerLabel: string;
  url: string;
  onDone: (signedIn: boolean) => void;
}> = ({ providerId, providerLabel, url, onDone }) => {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    if (busy) return;
    void window.orion?.cancelProviderAuth?.(providerId).catch(() => {});
    onDone(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (!value || busy || !window.orion?.submitProviderAuthCode) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.orion.submitProviderAuthCode({ providerId, code: value });
      if (result.ok) {
        onDone(true);
        return;
      }
      setError(result.error ?? 'The sign-in did not finish.');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'The sign-in did not finish.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={cancel}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-auth-code-title"
        data-testid="provider-auth-code-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id="provider-auth-code-title" className="modal-title">
          Sign in to {providerLabel}
        </h2>
        <p className="modal-subtitle">
          Finish signing in with Google in your browser. The last page shows a code: paste it here, or paste
          that page&apos;s full address.{' '}
          <button
            type="button"
            className="text-[var(--link,var(--accent))] underline underline-offset-2"
            onClick={() => void window.orion?.openExternalUrl?.(url)}
          >
            Open the sign-in page again
          </button>
        </p>
        <input
          className="mb-1 w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2 font-[family-name:var(--font-mono)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Authorization code"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          disabled={busy}
        />
        {error && <p className="mt-2 text-[12px] text-[var(--danger)]">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy || !code.trim()}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
};
