import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

export type ConfirmDialogTone = 'default' | 'danger';

export type ConfirmDialogOptions = {
  title: string;
  description?: React.ReactNode;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  testId?: string;
};

type ConfirmDialogRequest = {
  id: number;
  options: ConfirmDialogOptions;
  resolve: (confirmed: boolean) => void;
};

type ConfirmDialogState = {
  queue: ConfirmDialogRequest[];
  enqueue: (options: ConfirmDialogOptions) => Promise<boolean>;
  settle: (confirmed: boolean) => void;
  cancelAll: () => void;
};

let nextDialogId = 1;

export const useConfirmDialog = create<ConfirmDialogState>((set, get) => ({
  queue: [],
  enqueue: (options) =>
    new Promise<boolean>((resolve) => {
      const request: ConfirmDialogRequest = { id: nextDialogId++, options, resolve };
      set((state) => ({ queue: [...state.queue, request] }));
    }),
  settle: (confirmed) => {
    const [current, ...rest] = get().queue;
    if (!current) return;
    set({ queue: rest });
    current.resolve(confirmed);
  },
  cancelAll: () => {
    const pending = get().queue;
    if (pending.length === 0) return;
    set({ queue: [] });
    for (const request of pending) request.resolve(false);
  },
}));

/**
 * Opens an in-app Tailwind confirmation modal and resolves to `true` when
 * confirmed or `false` when cancelled / dismissed. Concurrent calls queue
 * cleanly in FIFO order.
 */
export const confirmDialog = (options: ConfirmDialogOptions): Promise<boolean> =>
  useConfirmDialog.getState().enqueue(options);

export type ConfirmModalProps = ConfirmDialogOptions & {
  onCancel: () => void;
  onConfirm: () => void;
};

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title,
  description,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  testId = 'confirm-dialog',
  onCancel,
  onConfirm,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key === 'Tab') {
        const focusables = [cancelRef.current, confirmRef.current].filter(
          (element): element is HTMLButtonElement => element !== null
        );
        if (focusables.length < 2) return;
        const currentIndex = focusables.indexOf(document.activeElement as HTMLButtonElement);
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

    // Capture phase so Escape closes only this modal and never leaks through to
    // underlying dialogs (e.g. ProjectPickerModal) or menus.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, []);

  const hasBody = Boolean(description) || Boolean(detail);
  const confirmButtonClass =
    tone === 'danger'
      ? 'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-0 bg-gradient-to-br from-[#ef5350] to-[#dc2626] px-4 py-2 text-[12px] font-medium text-white transition-[transform,box-shadow,opacity] duration-150 hover:-translate-y-px hover:shadow-[0_4px_14px_rgb(220_38_38_/_0.30)] active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent'
      : 'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-0 bg-[linear-gradient(135deg,var(--accent-strong),var(--accent-deep))] px-4 py-2 text-[12px] font-medium text-[var(--on-accent)] transition-[transform,box-shadow,opacity] duration-150 hover:-translate-y-px hover:shadow-[0_4px_14px_color-mix(in_srgb,var(--accent-deep)_30%,transparent)] active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent';

  const content = (
    <div
      className="fixed inset-0 z-[1250] flex items-center justify-center bg-[rgb(8_8_10_/_0.62)] p-6 backdrop-blur-[4px] [-webkit-app-region:no-drag] animate-[modal-backdrop-in_160ms_var(--ease-out)_both]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasBody ? descriptionId : undefined}
        data-testid={testId}
        className="w-full max-w-[440px] rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[color-mix(in_srgb,var(--bg-elevated)_92%,var(--bg-base))] px-[22px] pb-[18px] pt-[22px] text-[var(--text-primary)] [box-shadow:var(--shadow-lg),0_0_0_1px_rgb(255_255_255_/_0.04)] backdrop-blur-xl animate-[modal-in_200ms_var(--ease-out)_both]"
      >
        <h2
          id={titleId}
          className="m-0 mb-1.5 text-[16px] font-bold leading-snug tracking-[-0.01em] text-[var(--text-primary)]"
        >
          {title}
        </h2>
        {hasBody && (
          <div id={descriptionId}>
            {description && (
              <p className="m-0 whitespace-pre-line text-[12.5px] leading-[1.45] text-[var(--text-muted)]">
                {description}
              </p>
            )}
            {detail && (
              <pre className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-base)_72%,transparent)] px-3 py-2 font-[family-name:var(--font-mono)] text-[11.5px] leading-[1.5] text-[var(--text-secondary)]">
                {detail}
              </pre>
            )}
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            data-testid={`${testId}-cancel`}
            className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-hover)] px-4 py-2 text-[12px] font-medium text-[var(--text-secondary)] transition-[background-color,color,transform] duration-150 hover:bg-[color-mix(in_srgb,var(--bg-hover)_82%,var(--text-primary)_18%)] hover:text-[var(--text-primary)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            data-testid={`${testId}-confirm`}
            className={confirmButtonClass}
            onClick={onConfirm}
          >
            {confirmLabel}
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

export const ConfirmDialogHost: React.FC = () => {
  const active = useConfirmDialog((state) => state.queue[0] ?? null);
  const settle = useConfirmDialog((state) => state.settle);

  if (!active) return null;

  return (
    <ConfirmModal
      key={active.id}
      {...active.options}
      onCancel={() => settle(false)}
      onConfirm={() => settle(true)}
    />
  );
};
