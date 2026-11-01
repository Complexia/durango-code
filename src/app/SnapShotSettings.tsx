import React from 'react';
import { AppWindow, Camera, Keyboard, RefreshCw, ScanText, SquareArrowOutUpRight } from 'lucide-react';
import { toast } from 'sonner';
import { useOrionStore, type SnapShotAttachmentInfo, type SnapShotSettings } from '../store';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

// Opens a SnapShot's accessibility outline in the Code tab.
export const openSnapShotOutline = async (filePath: string) => {
  try {
    const result = await window.orion.openLinkedFile({ href: filePath, baseDirs: [] });
    if (!result.ok || !result.path || result.content === undefined) {
      toast.error(result.error ?? 'Could not open the SnapShot text.');
      return;
    }
    const store = useOrionStore.getState();
    store.openFile(result.path, result.content);
    store.setSettingsOpen(false);
    store.setActiveTab('code');
  } catch {
    toast.error('Could not open the SnapShot text.');
  }
};

// The line above a SnapShot file's name in the composer: which app it came
// from, and for the outline that it carries the app's text.
export const SnapShotAttachmentBadge: React.FC<{ snapshot: SnapShotAttachmentInfo }> = ({ snapshot }) => (
  <span
    className="flex min-w-0 items-center gap-1 text-[10.5px] font-medium uppercase tracking-wide text-[var(--text-secondary)]"
    title={
      snapshot.kind === 'accessibility'
        ? `App text captured from ${snapshot.appName}${snapshot.truncated ? ' (partial)' : ''}. Click to open.`
        : `SnapShot of ${snapshot.appName}${snapshot.windowTitle ? ` - ${snapshot.windowTitle}` : ''}`
    }
  >
    {snapshot.kind === 'accessibility' ? <ScanText size={11} /> : <AppWindow size={11} />}
    <span className="truncate">
      {snapshot.kind === 'accessibility' ? 'App text' : 'SnapShot'}
    </span>
  </span>
);

const keyFromCode = (code: string): string | null => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  return named[code] ?? null;
};

// A keydown as an Electron accelerator, or null while only modifiers are
// held. At least one modifier other than Shift is required so the chord
// can't swallow ordinary typing system-wide.
export const acceleratorFromKeyEvent = (event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>) => {
  const key = keyFromCode(event.code);
  if (!key) return null;
  const modifiers = [
    event.metaKey ? 'Command' : '',
    event.ctrlKey ? 'Control' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  if (!modifiers.some((modifier) => modifier !== 'Shift')) return null;
  return [...modifiers, key].join('+');
};

const acceleratorSymbols: Record<string, string> = {
  Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Control: '⌃', Ctrl: '⌃',
  Alt: '⌥', Option: '⌥', Shift: '⇧', Return: '↩', Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Space',
};
export const formatAccelerator = (accelerator: string) =>
  accelerator
    .split('+')
    .map((part) => acceleratorSymbols[part] ?? part)
    .join('');

type Props = {
  computerUsePerms: OrionComputerUsePermissions | null;
  computerUseBusyKind: OrionComputerUsePermissionKind | null;
  handleRequestComputerUsePermission: (kind: OrionComputerUsePermissionKind) => Promise<void>;
};

const Toggle: React.FC<{ checked: boolean; disabled?: boolean; title: string; onChange: (checked: boolean) => void }> = ({
  checked,
  disabled,
  title,
  onChange,
}) => (
  <label className="provider-toggle" title={title}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span />
  </label>
);

const statusChip = (status: OrionComputerUsePermissionStatus | undefined) =>
  status === 'granted'
    ? { className: 'authenticated', label: 'Granted' }
    : status === 'denied' || status === 'restricted'
      ? { className: 'unauthenticated', label: 'Not granted' }
      : { className: '', label: 'Not requested' };

export const SnapShotSettingsPanel: React.FC<Props> = ({
  computerUsePerms,
  computerUseBusyKind,
  handleRequestComputerUsePermission,
}) => {
  const settings = useOrionStore((state) => state.snapShotSettings);
  const setSnapShotSettings = useOrionStore((state) => state.setSnapShotSettings);
  const [state, setState] = React.useState<OrionSnapShotState | null>(null);
  const [recording, setRecording] = React.useState(false);
  const [capturing, setCapturing] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void window.orion?.snapShotGetState?.().then((next) => {
      if (!cancelled && next) setState(next);
    });
    const unsubscribe = window.orion?.onSnapShotState?.((next) => setState(next));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  React.useEffect(() => {
    if (!recording) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(false);
        return;
      }
      const accelerator = acceleratorFromKeyEvent(event);
      if (!accelerator) return;
      setRecording(false);
      setSnapShotSettings({ shortcut: { kind: 'accelerator', accelerator } });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, setSnapShotSettings]);

  const supported = state ? state.supported : isMac;
  if (!supported) {
    return (
      <div className="settings-empty-panel">
        <div className="settings-panel-title">SnapShot</div>
        <div className="settings-muted">SnapShot is available in Durango Code on macOS.</div>
      </div>
    );
  }

  const screenRecording = computerUsePerms?.screenRecording ?? state?.screenRecording;
  const accessibility = computerUsePerms?.accessibility ?? state?.accessibility;
  const requestMissingPermissions = async (next: SnapShotSettings) => {
    if (screenRecording !== 'granted') await handleRequestComputerUsePermission('screen-recording');
    else if (next.includeAppText && accessibility !== 'granted') await handleRequestComputerUsePermission('accessibility');
  };
  const update = (updates: Partial<SnapShotSettings>) => {
    const next = { ...settings, ...updates };
    setSnapShotSettings(updates);
    if (next.enabled && (updates.enabled === true || updates.includeAppText === true)) {
      void requestMissingPermissions(next);
    }
  };

  const shortcutKind = settings.shortcut.kind;
  const accelerator = settings.shortcut.kind === 'accelerator' ? settings.shortcut.accelerator : null;
  const trigger = state?.trigger;
  const helperLabel =
    state?.helper === 'ready'
      ? null
      : state?.helper === 'building'
        ? 'Preparing the capture helper…'
        : state?.helper === 'missing'
          ? 'The capture helper is unavailable in this build, so SnapShot cannot capture windows.'
          : null;
  const triggerLabel = !settings.enabled
    ? 'Off'
    : !trigger || trigger.kind === 'off'
      ? 'Starting…'
      : trigger.kind === 'modifier-pair'
        ? 'Listening for both Shift keys'
        : `Listening for ${formatAccelerator(trigger.accelerator)}${trigger.fallback ? ' (fallback)' : ''}`;

  const permissionRows: Array<{ kind: OrionComputerUsePermissionKind; title: string; desc: string; status?: OrionComputerUsePermissionStatus }> = [
    {
      kind: 'screen-recording',
      title: 'Screen Recording',
      desc: 'Required. Without it macOS hides other apps’ window contents.',
      status: screenRecording,
    },
    ...(settings.includeAppText
      ? [
          {
            kind: 'accessibility' as const,
            title: 'Accessibility',
            desc: 'Needed for app text. Without it SnapShots attach the image only.',
            status: accessibility,
          },
        ]
      : []),
  ];

  return (
    <>
      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">SnapShot</div>
          <div className="setting-label-desc">
            Press the shortcut in any app to attach its front window to your current draft: a screenshot and, if you
            like, the window’s text and controls. Durango Code comes forward with the capture in the composer. Window
            contents are sent to your model provider when you send the message.
          </div>
        </div>
        <Toggle checked={settings.enabled} title="SnapShot" onChange={(enabled) => update({ enabled })} />
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Include app text</div>
          <div className="setting-label-desc">
            Also attach the window’s accessibility outline (its controls, text, and their positions in the image) so
            agents can read it exactly. Needs Accessibility.
          </div>
        </div>
        <Toggle
          checked={settings.includeAppText}
          title="Include app text"
          onChange={(includeAppText) => update({ includeAppText })}
        />
      </div>

      <div className="setting-row setting-row-stacked">
        <div className="setting-label">
          <div className="setting-label-title">Shortcut</div>
          <div className="setting-label-desc">
            Press both Shift keys together, or use a key chord. Pressing it while Durango Code is in front captures the
            window behind it.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="browser-use-mode-options" role="group" aria-label="SnapShot shortcut">
            {(
              [
                { value: 'modifier-pair', label: 'Both Shift keys' },
                { value: 'accelerator', label: 'Key chord' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className={`browser-use-mode-button ${shortcutKind === option.value ? 'active' : ''}`}
                aria-pressed={shortcutKind === option.value}
                onClick={() => {
                  setRecording(false);
                  if (option.value === 'modifier-pair') {
                    setSnapShotSettings({ shortcut: { kind: 'modifier-pair', modifier: 'shift' } });
                  } else if (shortcutKind !== 'accelerator') {
                    setSnapShotSettings({ shortcut: { kind: 'accelerator', accelerator: 'CommandOrControl+Shift+2' } });
                  }
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          {shortcutKind === 'accelerator' && (
            <>
              <kbd className="rounded-md border border-[var(--border-default)] px-2 py-0.5 font-mono text-xs text-[var(--text-primary)]">
                {recording ? 'Press keys…' : formatAccelerator(accelerator ?? '')}
              </kbd>
              <button
                type="button"
                className="provider-auth-button"
                onClick={() => setRecording((value) => !value)}
                title={recording ? 'Press Escape to cancel' : 'Record a new key chord'}
              >
                <Keyboard size={13} />
                {recording ? 'Cancel' : 'Record shortcut'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Capture sound</div>
          <div className="setting-label-desc">Play the screenshot sound when a SnapShot is taken.</div>
        </div>
        <Toggle
          checked={settings.sound}
          disabled={!settings.enabled}
          title="Capture sound"
          onChange={(sound) => update({ sound })}
        />
      </div>

      {permissionRows.map((row) => {
        const chip = statusChip(row.status);
        return (
          <div className="setting-row" key={row.kind}>
            <div className="setting-label">
              <div className="setting-label-title">{row.title}</div>
              <div className="setting-label-desc">{row.desc}</div>
            </div>
            <div className="setting-row-actions">
              <span className={`provider-status-chip ${chip.className}`}>{chip.label}</span>
              <button
                type="button"
                className="provider-auth-button"
                onClick={() => void handleRequestComputerUsePermission(row.kind)}
                disabled={computerUseBusyKind !== null}
              >
                <SquareArrowOutUpRight size={13} />
                {computerUseBusyKind === row.kind
                  ? 'Requesting...'
                  : row.status === 'granted'
                    ? 'System Settings'
                    : 'Grant access'}
              </button>
            </div>
          </div>
        );
      })}

      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Status</div>
          <div className="setting-label-desc">
            {triggerLabel}.
            {helperLabel && (
              <>
                <br />
                {helperLabel}
              </>
            )}
            {settings.enabled && trigger?.error && (
              <>
                <br />
                {trigger.error}
              </>
            )}
            {state?.lastError && (
              <>
                <br />
                Last capture failed: {state.lastError.message}
              </>
            )}
            <br />
            macOS applies a new Screen Recording grant only after Durango Code relaunches.
          </div>
        </div>
        <div className="setting-row-actions">
          <button
            type="button"
            className="provider-auth-button"
            disabled={capturing || state?.helper === 'missing'}
            title="Capture the front-most window other than Durango Code"
            onClick={async () => {
              setCapturing(true);
              try {
                const result = await window.orion?.snapShotCaptureNow?.();
                if (result && !result.ok) toast.error(result.error ?? 'SnapShot failed.');
              } finally {
                setCapturing(false);
              }
            }}
          >
            <Camera size={13} />
            {capturing ? 'Capturing…' : 'Capture now'}
          </button>
          <button type="button" className="provider-auth-button" onClick={() => void window.orion?.relaunchApp?.()}>
            <RefreshCw size={13} />
            Relaunch
          </button>
        </div>
      </div>
    </>
  );
};
