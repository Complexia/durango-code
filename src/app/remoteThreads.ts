import type { Message, Thread, ThreadRecord, ThreadTranscript } from '../store';
import { isDefaultTitle } from './titles';

// Threads that run on another machine (remote control). The thread lives in
// this machine's sidebar like any other; its turns are started on the paired
// machine (Thread.remote) and its transcript mirrors that machine's copy
// (useRemoteThreadSync). The pure parts live here so they can be tested.

type ProviderId = 'claude' | 'codex' | 'grok' | 'muse' | 'opencode' | string;

/** The thread's reasoning effort for its model's provider, as remote runTurn takes it. */
export const remoteReasoningEffort = (thread: Thread, providerId: ProviderId | null | undefined) => {
  switch (providerId) {
    case 'claude':
      return thread.claudeReasoningEffort;
    case 'codex':
      return thread.codexReasoningEffort;
    case 'grok':
      return thread.grokReasoningEffort;
    case 'muse':
      return thread.museReasoningEffort;
    case 'opencode':
      return thread.openCodeReasoningEffort;
    default:
      return undefined;
  }
};

/** The agent settings a remote turn carries: what the prompt box shows for the thread. */
export const remoteTurnSettings = (thread: Thread, providerId: ProviderId | null | undefined) => {
  const reasoningEffort = remoteReasoningEffort(thread, providerId);
  return {
    modelId: thread.modelId,
    accessMode: thread.accessMode,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(providerId === 'codex' && thread.codexServiceTier ? { codexServiceTier: thread.codexServiceTier } : {}),
    ...(providerId === 'claude' && thread.claudeContextWindow
      ? { claudeContextWindow: thread.claudeContextWindow }
      : {}),
  };
};

const sameMessage = (left: Message | undefined, right: Message | undefined) =>
  left === right ||
  (!!left &&
    !!right &&
    left.id === right.id &&
    left.status === right.status &&
    left.statusText === right.statusText &&
    left.content.length === right.content.length &&
    (left.activities?.length ?? 0) === (right.activities?.length ?? 0) &&
    (left.activities?.at(-1)?.status ?? null) === (right.activities?.at(-1)?.status ?? null));

/**
 * Whether the other machine's transcript differs from the mirror. Cheap: a
 * transcript only grows at its end, so the count and the last two messages
 * tell (a refresh replaces it whole when they differ).
 */
export const remoteTranscriptChanged = (mirror: ThreadTranscript | undefined, host: Pick<ThreadRecord, 'messages' | 'btwExchanges'>) => {
  const mirrored = mirror?.messages ?? [];
  const incoming = Array.isArray(host.messages) ? host.messages : [];
  if (mirrored.length !== incoming.length) return true;
  if (!sameMessage(mirrored.at(-1), incoming.at(-1)) || !sameMessage(mirrored.at(-2), incoming.at(-2))) return true;
  return (mirror?.btwExchanges?.length ?? 0) !== (host.btwExchanges?.length ?? 0);
};

/**
 * How long after this machine started a turn there a refresh that doesn't
 * show it yet is ignored: the other machine saves its threads shortly after a
 * turn starts, so a read in between still has the old transcript and status.
 */
export const REMOTE_START_GRACE_MS = 15_000;

/**
 * What a refresh changes in the mirror, given the other machine's copy, or
 * null to wait (a turn was just started here and the copy predates it).
 */
export const remoteMirrorUpdate = (
  local: Pick<Thread, 'status' | 'title'> & { remote?: Pick<NonNullable<Thread['remote']>, 'hostTitle'> },
  mirrorMessageCount: number,
  host: Pick<ThreadRecord, 'status' | 'title' | 'messages'>,
  startedAt: number | null,
  now = Date.now()
): { status?: Thread['status']; title?: string } | null => {
  const hostMessages = Array.isArray(host.messages) ? host.messages.length : 0;
  if (
    startedAt !== null &&
    now - startedAt < REMOTE_START_GRACE_MS &&
    (host.status !== 'running' || hostMessages < mirrorMessageCount)
  ) {
    return null;
  }
  const patch: { status?: Thread['status']; title?: string } = {};
  if (host.status && host.status !== local.status) patch.status = host.status;
  // The other machine names the thread once its agent has worked a little;
  // until then this machine's title (from the first prompt) stands.
  // A rename here stands until that machine renames it.
  if (
    typeof host.title === 'string' &&
    host.title.trim() &&
    !isDefaultTitle(host.title) &&
    host.title !== local.title &&
    host.title !== local.remote?.hostTitle
  ) {
    patch.title = host.title;
  }
  return patch;
};

/**
 * Marks an attachment path that is the other machine's and has no copy here:
 * this machine must never read (or send on) a file of its own that happens to
 * live at the same path. Such a path shows as a file that isn't there.
 */
export const REMOTE_ONLY_PATH_PREFIX = 'remote-only:';
const hostPathOf = (value: string) =>
  value.startsWith(REMOTE_ONLY_PATH_PREFIX) ? value.slice(REMOTE_ONLY_PATH_PREFIX.length) : value;

/**
 * The other machine's messages with their attachments pointing at this
 * machine's copies (`paths`: its path → local path), the rest marked
 * remote-only, and the ones this machine has no copy of yet.
 */
export const mapRemoteAttachments = (
  messages: Message[],
  paths: Record<string, string> | undefined
): { messages: Message[]; missing: string[] } => {
  const missing = new Set<string>();
  const mapped = messages.map((message) => {
    if (!message.attachments?.length) return message;
    let changed = false;
    const attachments = message.attachments.map((attachment) => {
      const hostPath = hostPathOf(attachment.path ?? '');
      const local = paths?.[hostPath];
      if (local) {
        if (local === attachment.path) return attachment;
        changed = true;
        return { ...attachment, path: local };
      }
      if (!hostPath) return attachment;
      missing.add(hostPath);
      const remoteOnly = `${REMOTE_ONLY_PATH_PREFIX}${hostPath}`;
      if (remoteOnly === attachment.path) return attachment;
      changed = true;
      return { ...attachment, path: remoteOnly };
    });
    return changed ? { ...message, attachments } : message;
  });
  return { messages: mapped, missing: [...missing] };
};

/** That machine's thread ids deleted here, per machine (not listed again). */
const DISMISSED_KEY = 'durango.remoteDismissedThreads';

export const readDismissedRemoteThreads = (machineId: string): Set<string> => {
  try {
    const all = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '{}') as Record<string, string[]>;
    return new Set(Array.isArray(all[machineId]) ? all[machineId] : []);
  } catch {
    return new Set();
  }
};

export const dismissRemoteThread = (machineId: string, threadId: string) => {
  try {
    const all = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '{}') as Record<string, string[]>;
    const ids = new Set(Array.isArray(all[machineId]) ? all[machineId] : []);
    ids.add(threadId);
    // Bounded: the oldest dismissals go first.
    all[machineId] = [...ids].slice(-2000);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(all));
  } catch {}
};

/** The thread fields that are the agent's settings (what a remote turn may change there). */
export const REMOTE_SETTING_FIELDS = [
  'modelId',
  'accessMode',
  'codexReasoningEffort',
  'codexServiceTier',
  'claudeReasoningEffort',
  'claudeContextWindow',
  'grokReasoningEffort',
  'museReasoningEffort',
  'openCodeReasoningEffort',
] as const;
export type RemoteSettingField = (typeof REMOTE_SETTING_FIELDS)[number];
export type RemoteSettings = Partial<Record<RemoteSettingField, string>>;

export const remoteSettingsOf = (source: object | null | undefined): RemoteSettings => {
  const settings: RemoteSettings = {};
  for (const field of REMOTE_SETTING_FIELDS) {
    const value = (source as Record<string, unknown> | null | undefined)?.[field];
    if (typeof value === 'string' && value) settings[field] = value;
  }
  return settings;
};

/**
 * Bring a mirror's settings in line with that machine's (`host`): every field
 * the user hasn't changed here since the last sync takes that machine's value.
 * Returns the thread patch and the host settings to remember.
 */
export const adoptRemoteSettings = (
  thread: Pick<Thread, RemoteSettingField> & { remote?: Thread['remote'] },
  host: RemoteSettings
): { patch: Partial<Thread>; hostSettings: RemoteSettings } => {
  const known = thread.remote?.hostSettings;
  const patch: Record<string, string> = {};
  for (const field of REMOTE_SETTING_FIELDS) {
    const hostValue = host[field];
    if (hostValue === undefined) continue;
    const localValue = thread[field] as string | undefined;
    const changedHere = known?.[field] !== undefined && localValue !== known[field];
    if (!changedHere && localValue !== hostValue) patch[field] = hostValue;
  }
  return { patch: patch as Partial<Thread>, hostSettings: { ...known, ...host } };
};

const effortFieldOf = (providerId: ProviderId | null | undefined): RemoteSettingField | null =>
  providerId === 'claude'
    ? 'claudeReasoningEffort'
    : providerId === 'codex'
      ? 'codexReasoningEffort'
      : providerId === 'grok'
        ? 'grokReasoningEffort'
        : providerId === 'muse'
          ? 'museReasoningEffort'
          : providerId === 'opencode'
            ? 'openCodeReasoningEffort'
            : null;

/**
 * The settings a remote turn sends: all of them when it starts the thread
 * there, else only those changed here since that machine last reported them
 * (so a stale value here never overrides a change made there).
 */
export const remoteTurnSettingsToSend = (thread: Thread, providerId: ProviderId | null | undefined) => {
  const all = remoteTurnSettings(thread, providerId) as Record<string, string | undefined>;
  const known = thread.remote?.hostSettings;
  if (!thread.remote?.threadId || !known) return thread.remote?.threadId ? {} : all;
  const fieldFor: Record<string, RemoteSettingField | null> = {
    modelId: 'modelId',
    accessMode: 'accessMode',
    reasoningEffort: effortFieldOf(providerId),
    codexServiceTier: 'codexServiceTier',
    claudeContextWindow: 'claudeContextWindow',
  };
  return Object.fromEntries(
    Object.entries(all).filter(([key, value]) => {
      const field = fieldFor[key];
      return value !== undefined && field !== null && field !== undefined && known[field] !== value;
    })
  );
};
