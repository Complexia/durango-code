import React from 'react';
import { Cloud, X } from 'lucide-react';

// One-time notice after the Durango merge turned work sharing on by default
// (app/workspaceSyncConsent.ts). Either choice acknowledges it for good.
export const WorkspaceSyncNotice: React.FC<{
  onTurnOff: () => void;
  onAcknowledge: () => void;
}> = ({ onTurnOff, onAcknowledge }) => (
  <div
    role="status"
    aria-live="polite"
    data-testid="workspace-sync-notice"
    className="fixed bottom-5 right-5 z-[80] flex w-[360px] max-w-[calc(100vw-40px)] flex-col gap-3 rounded-lg border border-white/10 bg-[rgb(20_20_22_/_0.96)] p-4 text-[13px] leading-snug text-neutral-200 shadow-2xl backdrop-blur-md"
  >
    <div className="flex items-start gap-3">
      <Cloud size={16} className="mt-0.5 shrink-0 text-sky-400" aria-hidden />
      <p className="m-0 flex-1">
        Your coding work now syncs to your Durango account so Durango Chat can remember what
        you&apos;ve built.
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        className="-mr-1 -mt-1 rounded p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-200"
        onClick={onAcknowledge}
      >
        <X size={14} />
      </button>
    </div>
    <p className="m-0 pl-7 text-[12px] text-neutral-400">
      Threads, transcripts, usage, and code (through Durango Cloud repos) are shared. Change it
      anytime in Settings → Durango.
    </p>
    <div className="flex justify-end gap-2">
      <button
        type="button"
        className="rounded-md border border-white/10 px-3 py-1.5 text-[12px] font-semibold text-neutral-300 hover:bg-white/5"
        onClick={onTurnOff}
      >
        Turn off
      </button>
      <button
        type="button"
        className="rounded-md bg-sky-500 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-sky-400"
        onClick={onAcknowledge}
      >
        Got it
      </button>
    </div>
  </div>
);
