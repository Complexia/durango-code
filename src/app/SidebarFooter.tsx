import React from 'react';
import { Download, LogIn, RefreshCw, Settings } from 'lucide-react';
import type { AppUpdateState, OrionAccountState } from './appTypes';

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
      {appUpdateVisible && (
        <button
          type="button"
          className={`sidebar-update-button ${appUpdateState?.status ?? 'idle'}`}
          onClick={onAppUpdateClick}
          title={appUpdateTitle}
          disabled={
            appUpdateBusy || appUpdateState?.status === 'downloading' || appUpdateState?.status === 'restarting'
          }
        >
          {appUpdateState?.status === 'downloaded' || appUpdateState?.status === 'restarting' ? (
            <RefreshCw size={15} />
          ) : appUpdateState?.status === 'downloading' ? (
            <span
              className="sidebar-update-progress"
              style={
                {
                  '--update-progress': `${appUpdatePercent}%`,
                } as React.CSSProperties
              }
            >
              <Download size={14} />
            </span>
          ) : (
            <Download size={15} />
          )}
          <span>{appUpdateLabel}</span>
        </button>
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
