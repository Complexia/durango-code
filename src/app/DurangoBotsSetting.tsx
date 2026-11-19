import React from 'react';
import { defaultDurangoBotsSettings, defaultDurangoSettings, useOrionStore, type DurangoBotsSettings } from '../store';

// Settings → Durango: Durango bots on this computer (main: src/main/bot-replies.js
// signed in, src/main/local-bots.js signed out). On by default, separate from
// "Allow Durango Chat and Tasks to start agents": a bot's replies run on this
// computer's Claude Code unless the bot's own order puts the cloud first.

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
const THIS_DEVICE = isMac ? 'this Mac' : 'this computer';

export const DurangoBotsSetting: React.FC = () => {
  const durangoSettings = useOrionStore((state) => state.durangoSettings ?? defaultDurangoSettings);
  const setDurangoSettings = useOrionStore((state) => state.setDurangoSettings);
  const bots: DurangoBotsSettings = { ...defaultDurangoBotsSettings, ...durangoSettings.bots };
  const setBots = (updates: Partial<DurangoBotsSettings>) => setDurangoSettings({ bots: { ...bots, ...updates } });

  return (
    <>
      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Answer your bots on {THIS_DEVICE}</div>
          <div className="setting-label-desc">
            On by default. Your Durango bots reply through Claude Code on {THIS_DEVICE}, on your own Claude
            subscription, and can see and work in your projects here (the ones allowed for Durango below) and start
            threads in them. Messages you send from here are answered here first; a bot set to use the cloud first,
            or a reply {THIS_DEVICE} can't run, goes to Durango's cloud.
          </div>
        </div>
        <label className="provider-toggle" title={`Answer your bots on ${THIS_DEVICE}`}>
          <input type="checkbox" checked={bots.enabled} onChange={(e) => setBots({ enabled: e.target.checked })} />
          <span />
        </label>
      </div>
      <div className="setting-row">
        <div className="setting-label">
          <div className="setting-label-title">Access for bots</div>
          <div className="setting-label-desc">
            Full access: bot replies and the threads bots start on {THIS_DEVICE} run their commands without asking,
            since nobody is there to approve them.
          </div>
        </div>
      </div>
    </>
  );
};
