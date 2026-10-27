import React from 'react';
import { Download, LogIn, RefreshCw, Settings, TriangleAlert } from 'lucide-react';
import type { AppUpdateState, OrionAccountState } from './appTypes';
import { AppUpdateHoverCard } from './AppUpdateUi';

export type SidebarFooterProps = {
  appUpdateVisible: boolean;
  appUpdateState: AppUpdateState | null;
  appUpdateBusy: boolean;
  appUpdatePercent: number;
  appUpdateLabel: string;
  appUpdateTitle: string;
  accountState: OrionAccountState;
  accountName: string;
  accountInitials: string;
  accountLoading: boolean;
  accountBusy: boolean;
  onAppUpdateClick: () => void;
  onOpenAccount: () => void;
  onStartAccountAuth: () => void;
  onOpenSettings: () => void;
};

export const SidebarFooter = React.memo(function SidebarFooter({
  appUpdateVisible,
  appUpdateState,
  appUpdateBusy,
  appUpdatePercent,
  appUpdateLabel,
  appUpdateTitle,
  accountState,
  accountName,
  accountInitials,
  accountLoading,
  accountBusy,
  onAppUpdateClick,
  onOpenAccount,
  onStartAccountAuth,
  onOpenSettings,
}: SidebarFooterProps) {
  return (
    <div className="sidebar-footer">
      {appUpdateVisible && appUpdateState && (
        <AppUpdateHoverCard state={appUpdateState} percent={appUpdatePercent}>
          {/* Icon only; the hover card says what the update is. Not `disabled`
              while busy: a disabled button gets no hover, and the click
              handler already ignores downloads and restarts in progress. */}
          <button
            type="button"
            className={`sidebar-update-button ${appUpdateState.status}`}
            onClick={onAppUpdateClick}
            aria-label={`${appUpdateLabel}. ${appUpdateTitle}`}
            aria-disabled={
              appUpdateBusy || appUpdateState.status === 'downloading' || appUpdateState.status === 'restarting'
            }
          >
            {appUpdateState.status === 'downloaded' || appUpdateState.status === 'restarting' ? (
              <RefreshCw size={15} />
            ) : appUpdateState.status === 'downloading' ? (
              <span
                className="sidebar-update-progress"
                style={
                  {
                    '--update-progress': `${appUpdatePercent}%`,
                  } as React.CSSProperties
                }
              >
                <Download size={12} />
              </span>
            ) : appUpdateState.status === 'error' ? (
              <TriangleAlert size={15} />
            ) : (
              <Download size={15} />
            )}
          </button>
        </AppUpdateHoverCard>
      )}
      <button
        type="button"
        className={`sidebar-account-button ${accountState.authenticated ? 'signed-in' : ''}`}
        onClick={accountState.authenticated ? onOpenAccount : onStartAccountAuth}
        title={accountState.authenticated ? accountName : 'Sign in to your Durango account'}
        disabled={accountLoading || accountBusy}
      >
        {accountState.authenticated && accountState.user?.imageUrl ? (
          <img src={accountState.user.imageUrl} alt="" />
        ) : accountState.authenticated ? (
          <span>{accountInitials || 'D'}</span>
        ) : (
          <LogIn size={16} />
        )}
      </button>
      <button type="button" className="sidebar-settings-button" onClick={onOpenSettings} title="Settings">
        <Settings size={16} />
      </button>
    </div>
  );
});
