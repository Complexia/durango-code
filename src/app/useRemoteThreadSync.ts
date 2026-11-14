import React from 'react';
import { remoteAttentionPatch, useOrionStore, type Thread } from '../store';
import type { RemoteEvent, RemoteMachineEntry } from '../types';
import {
  adoptRemoteSettings,
  mapRemoteAttachments,
  readDismissedRemoteThreads,
  remoteMirrorUpdate,
  remoteSettingsOf,
  remoteTranscriptChanged,
} from './remoteThreads';

// Keeps the threads that run on other machines (Thread.remote) in step with
// those machines. The other machine is the authority: a refresh reads its copy
// of the thread (remoteFetchThread) and replaces the mirror's transcript,
// status and title. Refreshes follow that machine's push events (turn events
// while an agent streams, workspaceChanged after it saves), with a slow poll
// for open running threads in case an event is missed. Only threads open here
// are fetched that way (and their streams followed: `follow`); the rest are
// kept current by the machine's thread listing and refresh when opened.
//
// It also lists each connected machine's threads in this machine's sidebar
// (syncRemoteMachineThreads), so threads started there show here like local
// ones, and keeps every paired machine connected while remote control is on.

const EVENT_REFRESH_DELAY_MS = 1_000;
const RUNNING_POLL_MS = 8_000;
// Right after a turn starts there, poll quickly until its copy shows it.
const STARTING_POLL_MS = 1_500;
// Machine thread lists: after its push events (at most this often), and a
// slow poll besides.
const LIST_MIN_INTERVAL_MS = 4_000;
const LIST_POLL_MS = 60_000;
const RECONNECT_MS = 60_000;

type Options = {
  enabled: boolean;
  threads: Thread[];
  openThreadIds: string[];
  machines: RemoteMachineEntry[];
};

export type RemoteThreadSync = {
  /** A turn was just started on the other machine for this thread. */
  markStarted: (threadId: string) => void;
  /**
   * Refresh this thread soon (after a stop, say). `force` fetches it whole
   * even if that machine's copy didn't change (to undo a change shown here
   * that didn't go through).
   */
  refreshSoon: (threadId: string, options?: { force?: boolean }) => void;
};

export const useRemoteThreadSync = ({ enabled, threads, openThreadIds, machines }: Options): RemoteThreadSync => {
  const timersRef = React.useRef(new Map<string, number>());
  const inflightRef = React.useRef(new Set<string>());
  const againRef = React.useRef(new Set<string>());
  const startedAtRef = React.useRef(new Map<string, number>());
  // The storedVersion of each mirror's last fetched copy: an unchanged thread
  // isn't transferred again (most refreshes while a host streams).
  const versionsRef = React.useRef(new Map<string, string>());
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  // Back on after being off: nothing here is known current any more.
  React.useEffect(() => {
    if (enabled) versionsRef.current.clear();
  }, [enabled]);

  const refreshRef = React.useRef<(threadId: string) => Promise<void>>(async () => {});

  const schedule = React.useCallback((threadId: string, delay = EVENT_REFRESH_DELAY_MS) => {
    if (!enabledRef.current) return;
    const timers = timersRef.current;
    if (timers.has(threadId)) return;
    timers.set(
      threadId,
      window.setTimeout(() => {
        timers.delete(threadId);
        void refreshRef.current(threadId);
      }, delay)
    );
  }, []);

  refreshRef.current = async (threadId: string) => {
    if (inflightRef.current.has(threadId)) {
      againRef.current.add(threadId);
      return;
    }
    const shell = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
    const remote = shell?.remote;
    if (!remote?.threadId || !window.orion?.remoteFetchThread) return;
    inflightRef.current.add(threadId);
    let retrySoon = false;
    try {
      const knownVersion = versionsRef.current.get(threadId);
      // (A forced refresh dropped the version, so the copy comes whole.)
      const result = await window.orion.remoteFetchThread({
        machineId: remote.machineId,
        threadId: remote.threadId,
        ...(knownVersion ? { knownVersion } : {}),
      });
      if (result?.ok && result.unchanged) {
        // Just started there and not saved yet: look again soon.
        if (startedAtRef.current.has(threadId)) retrySoon = true;
        return;
      }
      if (!result?.ok || !result.thread) {
        // Started here, then deleted there: it isn't running anywhere.
        if (result?.error && /not found on the host/i.test(result.error) && !startedAtRef.current.has(threadId)) {
          const gone = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
          if (gone?.status === 'running') useOrionStore.getState().updateThread(threadId, { status: 'idle' });
        }
        return;
      }
      const state = useOrionStore.getState();
      const current = state.threads.find((candidate) => candidate.id === threadId);
      if (current?.remote?.machineId !== remote.machineId || current.remote.threadId !== remote.threadId) return;
      const host = result.thread;
      const mirror = state.transcripts[threadId];
      const startedAt = startedAtRef.current.get(threadId) ?? null;
      const update = remoteMirrorUpdate(
        current,
        mirror?.messages.length ?? current.summary.messageCount,
        host,
        startedAt
      );
      if (!update) {
        retrySoon = true;
        return;
      }
      startedAtRef.current.delete(threadId);
      if (result.storedVersion) versionsRef.current.set(threadId, result.storedVersion);
      else versionsRef.current.delete(threadId);
      const hostMessages = Array.isArray(host.messages) ? host.messages : [];
      const { messages, missing } = mapRemoteAttachments(hostMessages, current.remote.attachmentPaths);
      // A new version there is a changed thread, wherever in it the change is
      // (the cheap check only looks at its end, for hosts without versions).
      if (result.storedVersion || remoteTranscriptChanged(mirror, host)) {
        state.updateThreadTranscript(threadId, (transcript) => ({
          ...transcript,
          messages,
          btwExchanges: host.btwExchanges,
        }));
      }
      if (missing.length > 0) void fetchAttachmentsRef.current(threadId, remote.machineId, missing);
      // That machine's model, access and effort for the thread (a model it
      // lacks falls back there), unless changed here since.
      const adopted = adoptRemoteSettings(current, remoteSettingsOf(host));
      const settingsPatch: Partial<typeof current> = { ...adopted.patch };
      const hostTitle = typeof host.title === 'string' && host.title ? host.title : current.remote.hostTitle;
      if (
        JSON.stringify(adopted.hostSettings) !== JSON.stringify(current.remote.hostSettings ?? {}) ||
        hostTitle !== current.remote.hostTitle
      ) {
        const latestRemote = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId)?.remote;
        if (latestRemote) settingsPatch.remote = { ...latestRemote, hostSettings: adopted.hostSettings, hostTitle };
      }
      // A provider-native subagent there (listed under its parent's mirror):
      // its type, prompt and report, which the listing leaves out.
      const hostSubagent = (host as { subagent?: Thread['subagent'] }).subagent;
      if (
        current.parentThreadId &&
        hostSubagent &&
        typeof hostSubagent.id === 'string' &&
        typeof hostSubagent.providerId === 'string' &&
        JSON.stringify(hostSubagent) !== JSON.stringify(current.subagent ?? null)
      ) {
        settingsPatch.subagent = hostSubagent;
      }
      // The actions it waits on the user for there (request_user_action).
      // Its subagents' too, as that machine rolls them up (older hosts: its own).
      // A subagent there whose parent is mirrored here keeps none: that
      // machine rolls them up to the thread it lists, whose mirror has them,
      // and a second copy would show every card twice.
      const parentMirror = current.parentThreadId
        ? state.threads.find((candidate) => candidate.id === current.parentThreadId)
        : undefined;
      const rolledUpThere = parentMirror?.remote?.machineId === remote.machineId;
      const attention = remoteAttentionPatch(
        { userActions: current.userActions, remote: settingsPatch.remote ?? current.remote },
        rolledUpThere
          ? undefined
          : Array.isArray(result.pendingUserActions)
            ? result.pendingUserActions
            : Array.isArray(host.userActions)
              ? host.userActions
              : undefined,
        Boolean(current.remote.needsInputSince)
      );
      // A run that ended there lets the thread's queued follow-ups go out
      // (App's queued-message effect).
      const patch = { ...update, ...settingsPatch, ...attention };
      if (Object.keys(patch).length > 0) state.updateThread(threadId, patch);
    } catch {
      // Unreachable for now: the next event or poll tries again.
    } finally {
      inflightRef.current.delete(threadId);
      if (againRef.current.delete(threadId)) schedule(threadId);
      else if (retrySoon) schedule(threadId, STARTING_POLL_MS);
    }
  };

  // That machine's attachments in the mirror: fetch a copy of each once, then
  // point the transcript at it.
  const fetchingRef = React.useRef(new Set<string>());
  // Attachments that machine won't serve (a dropped file referenced where it
  // is, outside its attachment folder; too large; gone): not asked for again
  // this session. The transcript still shows their names.
  const unavailableRef = React.useRef(new Set<string>());
  const fetchAttachmentsRef = React.useRef(async (threadId: string, machineId: string, hostPaths: string[]) => {
    if (!window.orion?.remoteFetchAttachment) return;
    const fetched: Record<string, string> = {};
    for (const hostPath of hostPaths) {
      const key = `${machineId}:${hostPath}`;
      if (fetchingRef.current.has(key) || unavailableRef.current.has(key)) continue;
      fetchingRef.current.add(key);
      try {
        const result = await window.orion.remoteFetchAttachment({ machineId, path: hostPath });
        if (result?.ok && result.path) fetched[hostPath] = result.path;
        else unavailableRef.current.add(key);
      } catch {
        unavailableRef.current.add(key);
      } finally {
        fetchingRef.current.delete(key);
      }
    }
    if (Object.keys(fetched).length === 0) return;
    const state = useOrionStore.getState();
    const current = state.threads.find((candidate) => candidate.id === threadId);
    if (current?.remote?.machineId !== machineId) return;
    const attachmentPaths = { ...current.remote.attachmentPaths, ...fetched };
    state.updateThread(threadId, { remote: { ...current.remote, attachmentPaths } });
    state.updateThreadTranscript(threadId, (transcript) => ({
      ...transcript,
      messages: mapRemoteAttachments(transcript.messages, fetched).messages,
    }));
  });

  // A failed connection changes the machine's status, which reruns the effects
  // that connect: at most one attempt per machine per RECONNECT_MS, unless it
  // is connected (then connecting again is free).
  const connectAttemptsRef = React.useRef(new Map<string, number>());
  const machinesRef = React.useRef(machines);
  machinesRef.current = machines;
  const connectThrottled = React.useCallback((machineId: string) => {
    const status = machinesRef.current.find((machine) => machine.id === machineId)?.status;
    if (status === 'connected' || status === 'connecting') return;
    const last = connectAttemptsRef.current.get(machineId) ?? 0;
    if (Date.now() - last < RECONNECT_MS) return;
    connectAttemptsRef.current.set(machineId, Date.now());
    void window.orion?.remoteConnectMachine?.({ machineId }).catch(() => {});
  }, []);

  // Which mirrored threads to keep current, and the machines they need.
  const openIds = React.useMemo(() => new Set(openThreadIds), [openThreadIds]);
  const watched = React.useMemo(
    () =>
      enabled
        ? threads.filter((thread) => thread.remote?.threadId && openIds.has(thread.id))
        : [],
    [enabled, openIds, threads]
  );
  const watchedKey = watched
    .map((thread) => `${thread.id}:${thread.remote?.machineId}:${thread.remote?.threadId}:${thread.status}`)
    .join('|');
  const connectedKey = machines
    .filter((machine) => machine.status === 'connected')
    .map((machine) => machine.id)
    .sort()
    .join('|');

  // Connect to their machines and refresh them whenever the set changes or a
  // machine (re)connects.
  React.useEffect(() => {
    if (!enabled) return;
    const machineIds = new Set(watched.map((thread) => thread.remote!.machineId));
    for (const machineId of machineIds) connectThrottled(machineId);
    for (const thread of watched) schedule(thread.id, 0);
    // Each connected machine streams the threads open here (and nothing else
    // beyond run and question events).
    for (const machine of machinesRef.current) {
      if (machine.status !== 'connected') continue;
      const threadIds = watched
        .filter((thread) => thread.remote!.machineId === machine.id)
        .map((thread) => thread.remote!.threadId!);
      void window.orion?.remoteFollowThreads?.({ machineId: machine.id, threadIds }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, watchedKey, connectedKey, schedule]);

  // Push events from the other machines.
  const watchedRef = React.useRef(watched);
  watchedRef.current = watched;
  React.useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = window.orion?.onRemoteEvent?.((event: RemoteEvent) => {
      for (const thread of watchedRef.current) {
        if (thread.remote?.machineId !== event.machineId) continue;
        if (event.kind === 'workspaceChanged' || event.payload?.threadId === thread.remote.threadId) {
          schedule(thread.id);
        }
      }
    });
    return () => unsubscribe?.();
  }, [enabled, schedule]);

  // A question or approval asked (or answered) there: re-read whether the
  // thread waits on the user, for the sidebar's "Needs you" (the open
  // thread's question cards read the questions themselves).
  React.useEffect(() => {
    if (!enabled) return undefined;
    const checking = new Set<string>();
    const unsubscribe = window.orion?.onRemoteEvent?.((event: RemoteEvent) => {
      if (event.kind !== 'turnEvent') return;
      const hostThreadId = event.payload?.threadId;
      const type = event.payload?.type;
      if (!hostThreadId || (type !== 'user-input' && type !== 'done' && type !== 'error')) return;
      const mirror = useOrionStore
        .getState()
        .threads.find((thread) => thread.remote?.machineId === event.machineId && thread.remote.threadId === hostThreadId);
      if (!mirror || checking.has(mirror.id) || !window.orion?.remoteListQuestions) return;
      checking.add(mirror.id);
      void window.orion
        .remoteListQuestions({ machineId: event.machineId, threadId: hostThreadId })
        .then((result) => {
          if (!result?.ok) return;
          const state = useOrionStore.getState();
          const current = state.threads.find((thread) => thread.id === mirror.id);
          if (!current?.remote) return;
          const patch = remoteAttentionPatch(current, current.userActions, (result.questions ?? []).length > 0);
          if (Object.keys(patch).length > 0) state.updateThread(current.id, patch);
        })
        .catch(() => {})
        .finally(() => checking.delete(mirror.id));
    });
    return () => unsubscribe?.();
  }, [enabled]);

  // A missed event must not leave a run looking stuck.
  const anyRunning = watched.some((thread) => thread.status === 'running');
  React.useEffect(() => {
    if (!enabled || !anyRunning) return undefined;
    const timer = window.setInterval(() => {
      for (const thread of watchedRef.current) {
        if (thread.status === 'running') schedule(thread.id);
      }
    }, RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyRunning, enabled, schedule]);

  // --- Machine thread lists --------------------------------------------
  const listTimersRef = React.useRef(new Map<string, number>());
  const lastListedRef = React.useRef(new Map<string, number>());
  const listingRef = React.useRef(new Set<string>());
  const listMachineRef = React.useRef<(machineId: string) => Promise<void>>(async () => {});
  listMachineRef.current = async (machineId: string) => {
    const machine = machines.find((candidate) => candidate.id === machineId);
    if (!enabledRef.current || !machine || !window.orion?.remoteListThreads) return;
    if (listingRef.current.has(machineId)) return;
    listingRef.current.add(machineId);
    // Failed or not, the next listing waits its turn (no tight retry loop).
    lastListedRef.current.set(machineId, Date.now());
    try {
      const result = await window.orion.remoteListThreads({ machineId });
      if (!result?.ok || !Array.isArray(result.threads) || !enabledRef.current) return;
      useOrionStore.getState().syncRemoteMachineThreads({ id: machine.id, name: machine.name }, result.threads, {
        // Kept current one by one, or just started here (the listing may
        // predate the turn): left alone.
        skip: new Set([...watchedRef.current.map((thread) => thread.id), ...startedAtRef.current.keys()]),
        dismissed: readDismissedRemoteThreads(machineId),
      });
    } catch {
      // Unreachable for now: its next event or the poll tries again.
    } finally {
      listingRef.current.delete(machineId);
    }
  };
  const scheduleList = React.useCallback((machineId: string) => {
    if (!enabledRef.current || listTimersRef.current.has(machineId)) return;
    const since = Date.now() - (lastListedRef.current.get(machineId) ?? 0);
    listTimersRef.current.set(
      machineId,
      window.setTimeout(() => {
        listTimersRef.current.delete(machineId);
        void listMachineRef.current(machineId);
      }, Math.max(0, LIST_MIN_INTERVAL_MS - since))
    );
  }, []);

  // List a machine as soon as it is connected, and on a slow poll.
  React.useEffect(() => {
    if (!enabled || !connectedKey) return undefined;
    const ids = connectedKey.split('|');
    for (const machineId of ids) scheduleList(machineId);
    const timer = window.setInterval(() => {
      for (const machineId of ids) scheduleList(machineId);
    }, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [connectedKey, enabled, scheduleList]);

  // A machine's threads changed there: list it again.
  React.useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = window.orion?.onRemoteEvent?.((event: RemoteEvent) => {
      if (event.kind === 'workspaceChanged') scheduleList(event.machineId);
    });
    return () => unsubscribe?.();
  }, [enabled, scheduleList]);

  // Keep every paired machine connected while remote control is on (an
  // offline one is tried again now and then).
  const pairedKey = machines
    .map((machine) => `${machine.id}:${machine.status}`)
    .sort()
    .join('|');
  React.useEffect(() => {
    if (!enabled) return undefined;
    const connectAll = () => {
      for (const machine of machines) {
        if (machine.status === 'offline' || machine.status === 'error') connectThrottled(machine.id);
      }
    };
    connectAll();
    const timer = window.setInterval(connectAll, RECONNECT_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pairedKey]);

  React.useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
      for (const timer of listTimersRef.current.values()) window.clearTimeout(timer);
      listTimersRef.current.clear();
    },
    []
  );

  return React.useMemo(
    () => ({
      markStarted: (threadId: string) => {
        startedAtRef.current.set(threadId, Date.now());
        schedule(threadId, STARTING_POLL_MS);
      },
      refreshSoon: (threadId: string, options?: { force?: boolean }) => {
        if (options?.force) versionsRef.current.delete(threadId);
        schedule(threadId);
      },
    }),
    [schedule]
  );
};
