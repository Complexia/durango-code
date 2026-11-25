// Work sharing ("Share coding work with Durango") and code sync ("Sync code to
// Durango Cloud") are both opt-in and off by default.
//
// Consent history:
// - Pre-Durango (no consentVersion): sharing was opt-in (`enabled: false`
//   default, `syncCode: true` default). A stored `enabled: true` therefore
//   reflects an explicit pre-merge opt-in.
// - Version 1 (Durango merge): switched sharing and code sync on by default and
//   migrated pre-Durango stores to `enabled: true` with a dismissable notice.
//   Stores with `consentVersion: 1` and `enabled: true` cannot distinguish an
//   explicit toggle in Settings from dismissing that notice ("Got it" or X).
// - Version 2 (opt-in): both sharing and code sync default to off. Anyone on
//   version 1 who had `enabled: true` is reset to off and asked once via the
//   opt-in dialog when signed in; anyone on version 1 who explicitly turned it
//   off stays off without being prompted again; anyone upgrading directly from
//   pre-Durango who had explicitly enabled it keeps their choice.
//
// Dependency-free: shared by the renderer store and main's startup seeding.

export const WORKSPACE_SYNC_CONSENT_VERSION = 2;

export type WorkspaceSyncConsentSettings = {
  enabled: boolean;
  syncCode: boolean;
  /** Consent policy the settings were last reconciled with (absent = pre-Durango, 1 = merge opt-out, 2 = opt-in). */
  consentVersion?: number;
  /** The one-time opt-in consent prompt was answered (or settled explicitly in Settings). */
  consentNoticeSeen?: boolean;
};

export const defaultWorkspaceSyncConsentSettings = {
  enabled: false,
  syncCode: false,
  consentVersion: WORKSPACE_SYNC_CONSENT_VERSION,
  consentNoticeSeen: false,
} satisfies WorkspaceSyncConsentSettings;

export const migrateWorkspaceSyncSettings = (
  persisted: Partial<WorkspaceSyncConsentSettings> | null | undefined
): Required<WorkspaceSyncConsentSettings> => {
  if (!persisted || typeof persisted !== 'object') {
    return { ...defaultWorkspaceSyncConsentSettings };
  }
  const version = Number(persisted.consentVersion) || 0;
  if (version >= WORKSPACE_SYNC_CONSENT_VERSION) {
    return {
      enabled: persisted.enabled === true,
      syncCode: persisted.syncCode === true,
      consentVersion: version,
      consentNoticeSeen: persisted.consentNoticeSeen === true,
    };
  }
  if (version === 1) {
    // Version 1 switched everyone on by default. An explicit `enabled: false`
    // means the user already opted out — respect it without prompting again.
    if (persisted.enabled === false) {
      return {
        enabled: false,
        syncCode: false,
        consentVersion: WORKSPACE_SYNC_CONSENT_VERSION,
        consentNoticeSeen: true,
      };
    }
    // Version 1 `enabled: true` cannot tell an explicit toggle apart from the
    // automatic merge migration (even when `consentNoticeSeen` is true, since
    // dismissing the toast set it). Lean toward off and ask clearly once.
    return {
      enabled: false,
      syncCode: false,
      consentVersion: WORKSPACE_SYNC_CONSENT_VERSION,
      consentNoticeSeen: false,
    };
  }
  // Pre-Durango (no consentVersion): `enabled` defaulted to false, so `true`
  // could only come from an explicit opt-in.
  if (persisted.enabled === true) {
    return {
      enabled: true,
      syncCode: persisted.syncCode === true,
      consentVersion: WORKSPACE_SYNC_CONSENT_VERSION,
      consentNoticeSeen: true,
    };
  }
  return {
    enabled: false,
    syncCode: false,
    consentVersion: WORKSPACE_SYNC_CONSENT_VERSION,
    consentNoticeSeen: false,
  };
};

/** Show the one-time opt-in consent dialog once signed in, while sharing is off and unanswered. */
export const shouldShowWorkspaceSyncConsentPrompt = (
  settings: Partial<WorkspaceSyncConsentSettings> | null | undefined,
  authenticated: boolean
) => Boolean(authenticated && settings?.enabled !== true && settings?.consentNoticeSeen !== true);
