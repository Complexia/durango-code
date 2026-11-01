import React from 'react';
import { ChevronDown, ChevronUp, Monitor, Power, RefreshCw, Smartphone, X } from 'lucide-react';
import type { DeviceEvent, OpenDevice } from '../types';

// Floating card at the top of a thread pane showing the simulator or emulator
// that thread's agent opened (device_open): its latest screenshot, refreshed
// when the agent takes one, on Refresh, and every LIVE_INTERVAL_MS while the
// card is expanded, Live is on and the window is visible. Main owns which
// devices are open (devices:openState + agent:device events), so the card
// survives a renderer reload.

const LIVE_INTERVAL_MS = 2000;

type Shot = { dataUrl: string; takenAt: number };

const formatAge = (takenAt: number, now: number) => {
  const seconds = Math.max(0, Math.round((now - takenAt) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
};

const useDocumentVisible = () => {
  const [visible, setVisible] = React.useState(() => document.visibilityState === 'visible');
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
};

export const DeviceCard: React.FC<{ threadId: string }> = ({ threadId }) => {
  const [open, setOpen] = React.useState<OpenDevice[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [shots, setShots] = React.useState<Record<string, Shot>>({});
  const [collapsed, setCollapsed] = React.useState(false);
  const [live, setLive] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const visible = useDocumentVisible();
  const inFlight = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    void window.orion?.getOpenDevices?.(threadId).then((devices) => {
      if (!cancelled) setOpen(devices ?? []);
    });
    const off = window.orion?.onDeviceEvent?.((event: DeviceEvent) => {
      if (event.threadId !== threadId) return;
      if (event.type === 'opened') {
        const { type: _type, threadId: _thread, ...entry } = event;
        setOpen((current) => [...current.filter((item) => item.device.id !== entry.device.id), entry]);
        setActiveId(entry.device.id);
        setCollapsed(false);
      } else if (event.type === 'closed') {
        setOpen((current) => current.filter((item) => item.device.id !== event.deviceId));
        setShots((current) => {
          const next = { ...current };
          delete next[event.deviceId];
          return next;
        });
      } else if (event.type === 'screenshot') {
        setShots((current) => ({ ...current, [event.deviceId]: { dataUrl: event.dataUrl, takenAt: event.takenAt } }));
      }
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [threadId]);

  const active = open.find((item) => item.device.id === activeId) ?? open[open.length - 1] ?? null;
  const deviceId = active?.device.id ?? null;

  const refresh = React.useCallback(async () => {
    if (!deviceId || !window.orion?.screenshotDevice || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await window.orion.screenshotDevice({ threadId, deviceId });
      if (result.ok && result.dataUrl) {
        const shot = { dataUrl: result.dataUrl, takenAt: result.takenAt ?? Date.now() };
        setShots((current) => ({ ...current, [deviceId]: shot }));
        setError(null);
      } else if (result.error) {
        setError(result.error);
      }
    } finally {
      inFlight.current = false;
    }
  }, [threadId, deviceId]);

  // First frame as soon as a device shows up.
  React.useEffect(() => {
    if (deviceId) void refresh();
  }, [deviceId, refresh]);

  React.useEffect(() => {
    if (!deviceId || collapsed || !live || !visible) return undefined;
    const timer = window.setInterval(() => void refresh(), LIVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [deviceId, collapsed, live, visible, refresh]);

  React.useEffect(() => {
    if (!deviceId || collapsed) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [deviceId, collapsed]);

  if (!active) return null;
  const shot = deviceId ? shots[deviceId] : undefined;
  const { device } = active;

  const close = async (shutdown: boolean) => {
    if (!window.orion?.closeDevice) return;
    setBusy(shutdown ? 'shutdown' : 'close');
    try {
      const result = await window.orion.closeDevice({ threadId, deviceId: device.id, shutdown });
      if (!result.ok && result.error) setError(result.error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pointer-events-none relative z-30 h-0 shrink-0">
      <div className="pointer-events-auto absolute right-3 top-2 w-[236px] overflow-hidden rounded-xl border border-white/10 bg-[#161619]/95 shadow-2xl shadow-black/50 backdrop-blur">
        <div className="flex items-center gap-1.5 px-2.5 py-2">
          <Smartphone size={14} className="shrink-0 text-[#a1a1aa]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-[#e4e4e7]" title={device.name}>
              {device.name}
            </div>
            <div className="truncate text-[10px] text-[#8a8a94]">
              {device.platform === 'ios' ? 'iOS' : 'Android'}
              {device.version ? ` ${device.version}` : ''}
              {open.length > 1 ? ` · ${open.length} open` : ''}
            </div>
          </div>
          <button
            type="button"
            className="rounded p-1 text-[#a1a1aa] hover:bg-white/10 hover:text-white"
            title={collapsed ? 'Expand' : 'Collapse'}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
          <button
            type="button"
            className="rounded p-1 text-[#a1a1aa] hover:bg-white/10 hover:text-white disabled:opacity-40"
            title="Close (ends the agent's session; the device keeps running)"
            disabled={busy !== null}
            onClick={() => void close(false)}
          >
            <X size={14} />
          </button>
        </div>
        {!collapsed && (
          <>
            {open.length > 1 && (
              <div className="flex flex-wrap gap-1 px-2.5 pb-2">
                {open.map((item) => (
                  <button
                    key={item.device.id}
                    type="button"
                    className={`rounded-md px-1.5 py-0.5 text-[10px] ${item.device.id === device.id ? 'bg-white/15 text-white' : 'bg-white/5 text-[#a1a1aa] hover:bg-white/10'}`}
                    onClick={() => setActiveId(item.device.id)}
                  >
                    {item.device.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex max-h-[420px] justify-center bg-black/40 px-2 py-2">
              {shot ? (
                <img
                  src={shot.dataUrl}
                  alt={`Screen of ${device.name}`}
                  className="max-h-[404px] w-auto max-w-full rounded-md object-contain"
                  draggable={false}
                />
              ) : (
                <div className="flex h-40 items-center text-[11px] text-[#8a8a94]">Waiting for a screenshot…</div>
              )}
            </div>
            {error && <div className="px-2.5 pt-1.5 text-[10px] text-red-400">{error}</div>}
            <div className="flex items-center gap-1 px-2 py-1.5">
              <button
                type="button"
                className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-[#a1a1aa] hover:bg-white/10 hover:text-white"
                title="Take a new screenshot"
                onClick={() => void refresh()}
              >
                <RefreshCw size={11} />
                {shot ? formatAge(shot.takenAt, now) : 'Refresh'}
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={live}
                className={`rounded px-1.5 py-1 text-[10px] ${live ? 'text-emerald-400' : 'text-[#8a8a94]'} hover:bg-white/10`}
                title="Refresh every 2 seconds while this card is open"
                onClick={() => setLive((value) => !value)}
              >
                ● Live
              </button>
              <div className="flex-1" />
              {device.platform === 'ios' && (
                <button
                  type="button"
                  className="rounded p-1 text-[#a1a1aa] hover:bg-white/10 hover:text-white"
                  title="Show in Simulator"
                  onClick={() => void window.orion?.showDevice?.({ threadId, deviceId: device.id })}
                >
                  <Monitor size={13} />
                </button>
              )}
              <button
                type="button"
                className="rounded p-1 text-[#a1a1aa] hover:bg-white/10 hover:text-red-400 disabled:opacity-40"
                title="Shut down the device"
                disabled={busy !== null}
                onClick={() => void close(true)}
              >
                <Power size={13} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default React.memo(DeviceCard);
