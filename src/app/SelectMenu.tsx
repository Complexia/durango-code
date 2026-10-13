import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

type SelectMenuOption = { value: string; label: string };

type SelectMenuProps = {
  /** Accessible name; also the trigger's tooltip. */
  label: string;
  value: string | null;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
};

/**
 * Small dropdown for a short list of mutually exclusive values — the shape a
 * native <select> would take, minus the OS-drawn popup that ignores the app's
 * theme. Sits next to the model picker in Settings.
 */
export const SelectMenu = ({ label, value, options, onChange, disabled }: SelectMenuProps) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [flipped, setFlipped] = useState(false);
  const selected = options.find((option) => option.value === value) ?? null;

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Open upward when the menu would run off the bottom. Measured rather than
  // scrolled into view, so opening it never moves the page under the cursor.
  useLayoutEffect(() => {
    if (!open) {
      setFlipped(false);
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const anchorTop = anchorRef.current?.getBoundingClientRect().top ?? 0;
    setFlipped(rect.bottom > window.innerHeight - 8 && anchorTop - 8 >= rect.height);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={anchorRef}>
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex h-[34px] items-center gap-1.5 rounded-md border border-[#343438] bg-[#232324] px-2.5 text-xs font-medium text-[#c8c8c8] transition-colors hover:border-[#4a4a50] hover:bg-[#2a2a2b] hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
      >
        <span className="truncate">{selected?.label ?? 'Default'}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="listbox"
          className={`absolute right-0 z-[100] max-h-[320px] min-w-[9rem] overflow-y-auto rounded-lg border border-[#3a3a40] bg-[#1f1f21] py-1 shadow-2xl ${
            flipped ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'
          }`}
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[#2f2f31] ${
                  isSelected ? 'text-white' : 'text-[#c0c0c0]'
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <Check size={13} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
