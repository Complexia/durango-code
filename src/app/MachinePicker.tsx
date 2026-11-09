import React from 'react';
import { Check, ChevronDown, Monitor, MonitorSmartphone, Settings } from 'lucide-react';
import type { ThreadRemote } from '../store';
import type { RemoteMachineEntry } from '../types';

// Above the prompt box, left of the branch picker: which machine the thread's
// agents run on. This machine, or any machine paired under Remote control.
// The choice is made before the thread's first message; after that the
// thread stays where it started, and the button only says where that is.

const statusLabel: Record<RemoteMachineEntry['status'], string> = {
  connected: 'Online',
  connecting: 'Connecting…',
  offline: 'Offline',
  error: 'Unreachable',
};

type Props = {
  localName: string;
  machines: RemoteMachineEntry[];
  /** The thread's machine; null = this machine. */
  value: ThreadRemote | null;
  /** The thread has started: the machine can no longer change. */
  locked: boolean;
  onChange: (machine: RemoteMachineEntry | null) => void;
  onManage: () => void;
};

const MachinePicker = React.memo(function MachinePicker({ localName, machines, value, locked, onChange, onManage }: Props) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
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

  const current = value ? machines.find((machine) => machine.id === value.machineId) : null;
  const label = value ? (current?.name ?? value.machineName) : localName;
  const Icon = value ? MonitorSmartphone : Monitor;
  const title = locked
    ? `This thread runs on ${label}. Start a new thread to use another machine.`
    : 'Machine this thread’s agents run on';

  return (
    <div className="shell-branch-control machine-picker" ref={rootRef}>
      <button
        type="button"
        className={`shell-branch-trigger machine-picker-trigger${value ? ' remote' : ''}`}
        onClick={() => {
          if (!locked) setOpen((wasOpen) => !wasOpen);
        }}
        aria-disabled={locked}
        title={title}
        aria-haspopup={locked ? undefined : 'menu'}
        aria-expanded={open}
      >
        <Icon size={14} />
        <span className="truncate">{label}</span>
        {value && current && <span className={`machine-status-dot ${current.status}`} />}
        {!locked && <ChevronDown size={13} className={`project-pill-chevron ${open ? 'open' : ''}`} />}
      </button>
      {open && !locked && (
        <div className="shell-branch-picker machine-picker-menu" role="menu">
          <div className="branch-picker-note">Run this thread’s agents on</div>
          <button
            type="button"
            role="menuitem"
            className={`branch-picker-item ${value ? '' : 'selected'}`}
            onClick={() => {
              setOpen(false);
              onChange(null);
            }}
          >
            <Monitor size={13} />
            <span className="truncate">{localName}</span>
            <span className="machine-picker-hint">This machine</span>
            {!value && <Check size={13} />}
          </button>
          {machines.map((machine) => {
            const selected = value?.machineId === machine.id;
            return (
              <button
                key={machine.id}
                type="button"
                role="menuitem"
                className={`branch-picker-item ${selected ? 'selected' : ''}`}
                title={machine.error ?? undefined}
                onClick={() => {
                  setOpen(false);
                  onChange(machine);
                }}
              >
                <MonitorSmartphone size={13} />
                <span className="truncate">{machine.name}</span>
                <span className="machine-picker-hint">
                  <span className={`machine-status-dot ${machine.status}`} />
                  {statusLabel[machine.status]}
                </span>
                {selected && <Check size={13} />}
              </button>
            );
          })}
          <div className="project-picker-divider" />
          <button
            type="button"
            role="menuitem"
            className="branch-picker-item"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <Settings size={13} />
            <span className="truncate">Pair a machine…</span>
          </button>
        </div>
      )}
    </div>
  );
});

export default MachinePicker;
