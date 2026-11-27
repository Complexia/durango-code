import { useSyncExternalStore } from 'react';
import type { FileAttachment, Message } from '../store';

// A "Steer now" (⌘↩, or a queued bubble's Steer now) on a thread that runs on
// another machine. The message goes into that machine's turn over the relay,
// which takes a few seconds, and the mirror only has it once that machine's
// copy of the thread comes back. Meanwhile the transcript shows it from here,
// as a steered message that is sending (then sent), so it never leaves the
// screen. That machine's copy of it (its echo) replaces it in the same render
// (reconcileRemoteSteers): never both, never neither. A steer that fails
// leaves here and goes back to the queue (or the composer), keeping its text.
// Not saved: a steer in flight doesn't outlive the window.

export type PendingRemoteSteer = {
  id: string;
  /** What that machine records for it (recordSteeredMessage there). */
  content: string;
  attachments: FileAttachment[];
  ts: string;
  /** 'sent': that machine has it in the turn; its copy of the thread hasn't come back yet. */
  state: 'sending' | 'sent';
  /** The mirror's steered messages with the same text when it was sent: none of them is its echo. */
  earlierIds: string[];
};

/** The steered message that machine records for a steer of `text` with `attachments` (see App's performSteerWithContent). */
export const remoteSteerContent = (text: string, attachments: readonly FileAttachment[]) =>
  text.trim() || (attachments.length > 0 ? 'Attached file' : '');

const isSteered = (message: Message) => message.role === 'user' && message.steer === true;

/** The mirror's steered messages reading `content` (to tell a later echo from them). */
export const steeredMessageIds = (messages: readonly Message[] | undefined, content: string) =>
  (messages ?? []).filter((message) => isSteered(message) && message.content === content).map((message) => message.id);

/**
 * Which pending steers the mirror's transcript now has (that machine's echo of
 * each: a steered message with its text that wasn't there when it was sent,
 * matched in order) and which still show from here.
 */
export const reconcileRemoteSteers = (
  pending: readonly PendingRemoteSteer[],
  messages: readonly Message[]
): { visible: PendingRemoteSteer[]; echoes: Map<string, string> } => {
  const echoes = new Map<string, string>();
  if (pending.length === 0) return { visible: [], echoes };
  const visible: PendingRemoteSteer[] = [];
  const taken = new Set<string>();
  for (const steer of pending) {
    const earlier = new Set(steer.earlierIds);
    const echo = messages.find(
      (message) =>
        isSteered(message) && message.content === steer.content && !earlier.has(message.id) && !taken.has(message.id)
    );
    if (echo) {
      taken.add(echo.id);
      echoes.set(steer.id, echo.id);
    } else {
      visible.push(steer);
    }
  }
  return { visible, echoes };
};

/** The pending steer as the transcript draws it: a steered user message. */
export const pendingRemoteSteerMessage = (steer: PendingRemoteSteer): Message => ({
  id: steer.id,
  role: 'user',
  content: steer.content,
  ts: steer.ts,
  ...(steer.attachments.length > 0 ? { attachments: steer.attachments } : {}),
  steer: true,
});

const NONE: PendingRemoteSteer[] = [];
const pending = new Map<string, PendingRemoteSteer[]>();
// Echoes that took over a steer shown from here: they don't rise in again.
const adoptedEchoes = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const update = (threadId: string, next: PendingRemoteSteer[]) => {
  if (next.length > 0) pending.set(threadId, next);
  else pending.delete(threadId);
  emit();
};

export const pendingRemoteSteers = {
  get(threadId: string): PendingRemoteSteer[] {
    return pending.get(threadId) ?? NONE;
  },
  add(threadId: string, steer: PendingRemoteSteer) {
    update(threadId, [...(pending.get(threadId) ?? []), steer]);
  },
  /** That machine has it in the turn. */
  markSent(threadId: string, id: string) {
    const current = pending.get(threadId);
    if (!current?.some((steer) => steer.id === id && steer.state !== 'sent')) return;
    update(
      threadId,
      current.map((steer) => (steer.id === id ? { ...steer, state: 'sent' as const } : steer))
    );
  },
  remove(threadId: string, id: string) {
    const current = pending.get(threadId);
    if (!current?.some((steer) => steer.id === id)) return;
    update(
      threadId,
      current.filter((steer) => steer.id !== id)
    );
  },
  /** Drops the steers whose echo the transcript shows now (`echoes`: steer id → echo id). */
  settle(threadId: string, echoes: ReadonlyMap<string, string>) {
    const current = pending.get(threadId);
    if (!current || echoes.size === 0) return;
    update(
      threadId,
      current.filter((steer) => !echoes.has(steer.id))
    );
  },
  /** Marks echoes that take over a steer shown from here (they don't rise in again). */
  adopt(echoIds: Iterable<string>) {
    for (const id of echoIds) adoptedEchoes.add(id);
  },
  isAdoptedEcho(messageId: string) {
    return adoptedEchoes.has(messageId);
  },
};

export const usePendingRemoteSteers = (threadId: string): PendingRemoteSteer[] =>
  useSyncExternalStore(
    subscribe,
    () => pending.get(threadId) ?? NONE,
    () => NONE
  );
