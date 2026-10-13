// Work sharing ("Share coding work with Durango") defaults to Full after the
// Durango merge (durango-merge-plan.md §3.1). Before it, workspace sync was
// opt-in and persisted `enabled: false` for everyone who never touched it, so
// the persisted value cannot tell "never decided" from "chose off". Consent
// version 1 resolves that once: stores without a consentVersion move to
// enabled and get a one-time notice; from then on the user's choice sticks.
// Dependency-free: shared by the renderer store and main's startup seeding.

export const WORKSPACE_SYNC_CONSENT_VERSION = 1;

export type WorkspaceSyncConsentSettings = {
  enabled: boolean;
  syncCode: boolean;
  /** Consent policy the settings were last reconciled with (absent = pre-Durango). */
  consentVersion?: number;
  /** The one-time "your coding work now syncs" notice was acknowledged. */
  consentNoticeSeen?: boolean;
};

export const defaultWorkspaceSyncConsentSettings = {
  enabled: true,
  syncCode: true,
  consentVersion: WORKSPACE_SYNC_CONSENT_VERSION,
  consentNoticeSeen: false,
} satisfies WorkspaceSyncConsentSettings;

export const migrateWorkspaceSyncSettings = (
  persisted: Partial<WorkspaceSyncConsentSettings> | null | undefined
): Required<WorkspaceSyncConsentSettings> => {
  if (!persisted || typeof persisted !== 'object') return { ...defaultWorkspaceSyncConsentSettings };
  const merged = {
    ...defaultWorkspaceSyncConsentSettings,
    ...persisted,
    syncCode: persisted.syncCode !== false,
  };
  if ((Number(persisted.consentVersion) || 0) >= WORKSPACE_SYNC_CONSENT_VERSION) {
    return {
      ...merged,
      enabled: persisted.enabled !== false,
      consentNoticeSeen: persisted.consentNoticeSeen === true,
    };
  }
  // Pre-Durango settings: "off" was only ever the old default. Users who had
  // already opted in were informed back then and need no notice.
  return {
    ...merged,
    enabled: true,
    consentVersion: WORKSPACE_SYNC_CONSENT_VERSION,
    consentNoticeSeen: persisted.enabled === true,
  };
};

/** Show the one-time notice: sharing is on, the user is signed in, and they have not acknowledged it. */
export const shouldShowWorkspaceSyncNotice = (
  settings: Partial<WorkspaceSyncConsentSettings> | null | undefined,
  authenticated: boolean
) => Boolean(authenticated && settings?.enabled === true && settings?.consentNoticeSeen !== true);
