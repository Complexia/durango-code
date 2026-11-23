import { useSyncExternalStore } from 'react';
import type { Message } from '../store';

// A turn sent from the composer that is still in its preflight (transcript
// load, linked-task refresh, workspace setup, Durango memory, ...). The chat
// shows its prompt and a working run at once, from these placeholders; the
// turn start takes them (same ids, so nothing remounts) when it adds the real
// messages, and the composer drops them if the start fails.
export type PendingTurn = {
  userMessage: Message;
  runMessage: Message;
};

const pending = new Map<string, PendingTurn>();
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

export const pendingTurns = {
  set(threadId: string, turn: PendingTurn) {
    pending.set(threadId, turn);
    emit();
  },
  /** Removes and returns the thread's placeholders. */
  take(threadId: string): PendingTurn | undefined {
    const turn = pending.get(threadId);
    if (!turn) return undefined;
    pending.delete(threadId);
    emit();
    return turn;
  },
  /** Drops the placeholders, only if they are still `turn` when given. */
  clear(threadId: string, turn?: PendingTurn) {
    const current = pending.get(threadId);
    if (!current || (turn && current !== turn)) return;
    pending.delete(threadId);
    emit();
  },
};

export const usePendingTurn = (threadId: string): PendingTurn | undefined =>
  useSyncExternalStore(
    subscribe,
    () => pending.get(threadId),
    () => undefined
  );
