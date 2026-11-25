import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Cloud } from 'lucide-react';

export type WorkspaceSyncConsentDialogProps = {
  onDecline: () => void;
  onAccept: (options: { syncCode: boolean }) => void;
};

// One-time opt-in consent dialog shown once after signing in when workspace
// sync has not yet been decided (app/workspaceSyncConsent.ts). Both sharing
// and code sync stay off until the user explicitly turns them on; "Not now",
// Escape, and backdrop clicks all keep both off.
export const WorkspaceSyncConsentDialog: React.FC<WorkspaceSyncConsentDialogProps> = ({
  onDecline,
  onAccept,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const codeSyncId = useId();
  const [syncCode, setSyncCode] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const codeCheckboxRef = useRef<HTMLInputElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onDeclineRef = useRef(onDecline);
  onDeclineRef.current = onDecline;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    // Focus "Not now" rather than "Turn on sharing" so pressing Enter or Space
    // accidentally never enables syncing.
    declineRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      // Yield keyboard handling if a higher-layer modal (such as ConfirmModal
      // or RestartToUpdateDialog) is currently open above this dialog.
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals.length > 0 && modals[modals.length - 1] !== dialogRef.current) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDeclineRef.current();
        return;
      }
      if (event.key === 'Tab') {
        const focusables = [codeCheckboxRef.current, declineRef.current, acceptRef.current].filter(
          (element): element is HTMLInputElement | HTMLButtonElement => element !== null
        );
        if (focusables.length < 2) return;
        const currentIndex = focusables.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement);
        event.preventDefault();
        const nextIndex =
          currentIndex === -1
            ? event.shiftKey
              ? focusables.length - 1
              : 0
            : (currentIndex + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
        focusables[nextIndex]?.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, []);

  const content = (
    <div
      className="fixed inset-0 z-[1240] flex items-center justify-center bg-[rgb(8_8_10_/_0.62)] p-6 backdrop-blur-[4px] [-webkit-app-region:no-drag] animate-[modal-backdrop-in_160ms_var(--ease-out)_both]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDecline();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid="workspace-sync-consent-dialog"
        className="w-full max-w-[480px] rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[color-mix(in_srgb,var(--bg-elevated)_94%,var(--bg-base))] px-6 pb-5 pt-6 text-[var(--text-primary)] [box-shadow:var(--shadow-lg),0_0_0_1px_rgb(255_255_255_/_0.04)] backdrop-blur-xl animate-[modal-in_200ms_var(--ease-out)_both]"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <Cloud size={18} aria-hidden />
          </div>
          <div className="min-w-0">
            <h2
              id={titleId}
              className="m-0 text-[16px] font-bold leading-snug tracking-[-0.01em] text-[var(--text-primary)]"
            >
              Share coding work with Durango?
            </h2>
            <p
              id={descriptionId}
              className="m-0 mt-1 text-[12.5px] leading-[1.45] text-[var(--text-muted)]"
            >
              Off by default. Choose whether to sync coding work from this device to your Durango account.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-base)_72%,transparent)] px-3.5 py-3 text-[12.5px] leading-[1.45]">
          <div>
            <div className="font-semibold text-[var(--text-primary)]">What syncs</div>
            <p className="m-0 mt-0.5 text-[var(--text-secondary)]">
              Your projects, threads (full transcripts including agent steps and tool calls), and token usage.
            </p>
          </div>
          <div className="border-t border-[var(--border-subtle)] pt-2.5">
            <div className="font-semibold text-[var(--text-primary)]">What it powers</div>
            <p className="m-0 mt-0.5 text-[var(--text-secondary)]">
              Durango Chat memory, Usage history on durango.sh, and Durango Source profile stats.
            </p>
          </div>
        </div>

        <label
          htmlFor={codeSyncId}
          className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-base)_52%,transparent)] px-3.5 py-3 text-[12.5px] leading-[1.45] transition-colors hover:border-[var(--border-default)]"
        >
          <span className="relative mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
            <input
              ref={codeCheckboxRef}
              id={codeSyncId}
              type="checkbox"
              data-testid="workspace-sync-consent-code-toggle"
              checked={syncCode}
              onChange={(event) => setSyncCode(event.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden
              className={`flex h-4 w-4 items-center justify-center rounded-[4px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--accent)] peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-transparent ${
                syncCode
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'border-[var(--border-default)] bg-[var(--bg-base)] text-transparent'
              }`}
            >
              <Check size={11} strokeWidth={2.75} />
            </span>
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5 font-semibold text-[var(--text-primary)]">
              <span>Also sync code to Durango Cloud</span>
              <span className="rounded-full border border-[var(--border-subtle)] px-1.5 py-px text-[10px] font-medium text-[var(--text-muted)]">
                Off by default
              </span>
            </span>
            <span className="mt-0.5 block text-[12px] text-[var(--text-muted)]">
              Auto-publishes each git project as a private Durango Cloud repo and pushes new commits.
              Uncommitted edits are never uploaded.
            </span>
          </span>
        </label>

        <p className="m-0 mt-3 text-[11.5px] leading-[1.4] text-[var(--text-muted)]">
          Nothing syncs unless you turn it on. You can change or turn either off anytime in Settings → Durango.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <button
            ref={declineRef}
            type="button"
            data-testid="workspace-sync-consent-decline"
            className="inline-flex cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-hover)] px-4 py-2 text-[12.5px] font-semibold text-[var(--text-primary)] transition-[background-color,color,transform] duration-150 hover:bg-[color-mix(in_srgb,var(--bg-hover)_82%,var(--text-primary)_18%)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent"
            onClick={onDecline}
          >
            Not now
          </button>
          <button
            ref={acceptRef}
            type="button"
            data-testid="workspace-sync-consent-accept"
            className="inline-flex cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-transparent bg-[linear-gradient(135deg,var(--accent-strong),var(--accent-deep))] px-4 py-2 text-[12.5px] font-semibold text-[var(--on-accent)] transition-[transform,box-shadow,opacity] duration-150 hover:-translate-y-px hover:shadow-[0_4px_14px_color-mix(in_srgb,var(--accent-deep)_30%,transparent)] active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent"
            onClick={() => onAccept({ syncCode })}
          >
            Turn on sharing
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(content, document.body);
  }
  return content;
};
