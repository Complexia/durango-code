import React from 'react';
import { CheckCircle2, Download, RefreshCw, XCircle } from 'lucide-react';
import type { DeviceInfo, DevicePlatformAvailability, DeviceStatus } from '../types';

// Settings → Devices: the two opt-ins for simulator tools, what this machine
// can run, and the agent-device install. Polls only while installing.

const platformLabel = { ios: 'iOS Simulators', android: 'Android Emulators' } as const;

const Availability: React.FC<{ label: string; value: DevicePlatformAvailability | undefined }> = ({ label, value }) => (
  <div className="setting-row">
    <div className="setting-label">
      <div className="setting-label-title flex items-center gap-1.5">
        {value?.available ? (
          <CheckCircle2 size={14} className="text-emerald-400" />
        ) : (
          <XCircle size={14} className="text-[#8a8a94]" />
        )}
        {label}
      </div>
      <div className="setting-label-desc">
        {!value ? 'Checking…' : value.available ? value.reason ?? 'Available on this Mac.' : value.reason}
      </div>
    </div>
  </div>
);

const DevicesSettings: React.FC = () => {
  const [status, setStatus] = React.useState<DeviceStatus | null>(null);
  const [devices, setDevices] = React.useState<DeviceInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = React.useCallback(async () => {
    if (!window.orion?.getDeviceStatus) {
      setError('This build of Durango Code cannot use devices. Restart the app after updating.');
      return;
    }
    try {
      const next = await window.orion.getDeviceStatus();
      if (!mountedRef.current) return;
      setStatus(next);
      if (next.settings.useDevices && window.orion.listDevices) {
        const listed = await window.orion.listDevices();
        if (mountedRef.current) setDevices(listed.devices ?? []);
      } else {
        setDevices(null);
      }
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const installing = Boolean(status?.agentDevice.installing);
  React.useEffect(() => {
    if (!installing) return undefined;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [installing, refresh]);

  const update = async (patch: { useDevices?: boolean; agentsCanUseDevices?: boolean }) => {
    if (!window.orion?.setDeviceSettings) return;
    setError(null);
    await window.orion.setDeviceSettings(patch);
    await refresh();
  };

  const install = async () => {
    if (!window.orion?.installAgentDevice) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.orion.installAgentDevice();
      if (!mountedRef.current) return;
      setStatus(result.status);
      if (!result.ok) setError(result.error ?? 'Could not install agent-device.');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const settings = status?.settings;
  const tool = status?.agentDevice;
  const booted = devices?.filter((device) => device.state === 'booted') ?? [];

  return (
    <>
      <div className="settings-group-label">Simulators and emulators</div>
      <div className="settings-group">
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">Use devices</div>
            <div className="setting-label-desc">
              Let Durango Code list, boot, screenshot and shut down iOS Simulators and Android Emulators on this
              machine, and show the device a thread is using beside it.
            </div>
          </div>
          <label className="provider-toggle" title="Use devices">
            <input
              type="checkbox"
              checked={settings?.useDevices ?? false}
              disabled={!settings}
              onChange={(event) => void update({ useDevices: event.target.checked })}
            />
            <span />
          </label>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">Agents can use devices</div>
            <div className="setting-label-desc">
              Give agents on every provider the device_list, device_open, device_screenshot and device_close tools,
              and let them drive apps with agent-device (installed with npm or bun on first use). New agent sessions pick
              this up; turning it off refuses their next device call.
            </div>
          </div>
          <label className="provider-toggle" title="Agents can use devices">
            <input
              type="checkbox"
              checked={settings?.agentsCanUseDevices ?? false}
              disabled={!settings?.useDevices}
              onChange={(event) => void update({ agentsCanUseDevices: event.target.checked })}
            />
            <span />
          </label>
        </div>
      </div>

      <div className="settings-group-label">This machine</div>
      <div className="settings-group">
        <Availability label={platformLabel.ios} value={status?.platforms.ios} />
        <Availability label={platformLabel.android} value={status?.platforms.android} />
        {settings?.useDevices && devices && (
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-title">Devices</div>
              <div className="setting-label-desc">
                {devices.length === 0
                  ? 'No simulators or emulators found.'
                  : `${devices.length} found${booted.length ? `, running: ${booted.map((device) => device.name).join(', ')}` : ', none running'}.`}
              </div>
            </div>
            <button type="button" className="btn secondary small" onClick={() => void refresh()}>
              <RefreshCw size={13} />
              Refresh
            </button>
          </div>
        )}
      </div>

      <div className="settings-group-label">agent-device</div>
      <div className="settings-group">
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">
              agent-device {tool?.version ? <span className="text-[#8a8a94]">{tool.version}</span> : null}
            </div>
            <div className="setting-label-desc">
              {!tool
                ? 'Checking…'
                : tool.installed
                  ? 'Installed. Agents drive devices through it (MIT, by Callstack).'
                  : installing
                    ? `Installing with ${tool.installer ?? 'npm'}…`
                    : !tool.installer
                      ? 'Installing it needs npm, which comes with Node.js, and it was not found.'
                      : settings?.agentsCanUseDevices
                        ? 'Not installed yet. It installs on first use, or install it now.'
                        : 'Installs when you let agents use devices.'}
            </div>
            {tool && !tool.installed && !tool.installer && tool.installerMissingHint && (
              <div className="mt-1.5 flex items-center gap-2 text-xs text-[#a1a1aa]">
                <span>Install Node.js from</span>
                <button
                  type="button"
                  className="text-[#d4d4d8] underline underline-offset-2 hover:text-white"
                  onClick={() => void window.orion?.openExternalUrl?.('https://nodejs.org')}
                >
                  nodejs.org
                </button>
                <span>(it includes npm), then come back here.</span>
              </div>
            )}
          </div>
          {tool && !tool.installed && (
            <button
              type="button"
              className="btn secondary small"
              disabled={busy || installing || !tool.installer || !settings?.agentsCanUseDevices}
              onClick={() => void install()}
            >
              <Download size={13} className={busy || installing ? 'spinning' : ''} />
              {busy || installing ? 'Installing…' : 'Install'}
            </button>
          )}
        </div>
        {(error || tool?.error) && <div className="skills-message error">{error ?? tool?.error}</div>}
      </div>
    </>
  );
};

export default React.memo(DevicesSettings);
