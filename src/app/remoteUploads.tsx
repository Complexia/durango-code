import React from 'react';
import { RotateCw } from 'lucide-react';
import type { RemoteUploadProgress } from '../types';

// Files on their way to another machine: the prompt box starts sending a file
// as soon as it is attached to a thread that runs elsewhere (main:
// prepareRemoteAttachmentUpload), and the chip shows how far it got. The same
// progress shows on the sent message while its turn waits for the file.

const uploads = new Map<string, RemoteUploadProgress>();
const listeners = new Set<() => void>();
let subscribed = false;

const keyOf = (machineId: string, path: string) => `${machineId}\n${path}`;

const emit = () => {
  for (const listener of listeners) listener();
};

const record = (progress: RemoteUploadProgress) => {
  const key = keyOf(progress.machineId, progress.path);
  // Used by a turn, taken out of the prompt box, or left for the turn to send.
  if (progress.state === 'sent' || progress.state === 'cancelled' || progress.state === 'deferred') {
    uploads.delete(key);
  } else {
    uploads.set(key, progress);
  }
};

const ensureSubscribed = () => {
  if (subscribed || typeof window === 'undefined' || !window.orion?.onRemoteUploadProgress) return;
  subscribed = true;
  // Files an event spoke about while the list below was on its way: the event
  // is newer than the list (it may have finished or cancelled the upload).
  let touchedBeforeList: Set<string> | null = new Set();
  window.orion.onRemoteUploadProgress((progress) => {
    touchedBeforeList?.add(keyOf(progress.machineId, progress.path));
    record(progress);
    emit();
  });
  // Under way before this renderer loaded (a reload).
  void window.orion.remoteListUploads?.()
    .then((list) => {
      for (const progress of list ?? []) {
        if (!touchedBeforeList?.has(keyOf(progress.machineId, progress.path))) record(progress);
      }
      emit();
    })
    .catch(() => undefined)
    .finally(() => {
      touchedBeforeList = null;
    });
};

const subscribe = (listener: () => void) => {
  ensureSubscribed();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The upload of `path` to `machineId`, or (no machine given) to whichever machine it is going to. */
const findUpload = (machineId: string | null | undefined, path: string) => {
  if (machineId) return uploads.get(keyOf(machineId, path));
  for (const progress of uploads.values()) if (progress.path === path) return progress;
  return undefined;
};

export const useRemoteUpload = (machineId: string | null | undefined, path: string) =>
  React.useSyncExternalStore(subscribe, () => findUpload(machineId, path));

export const prepareRemoteUpload = (
  machineId: string,
  attachment: { id: string; name: string; path: string; mimeType?: string; size?: number }
) => {
  if (!attachment.path) return;
  ensureSubscribed();
  void window.orion?.remotePrepareUpload?.({
    machineId,
    attachment: {
      id: attachment.id,
      name: attachment.name,
      path: attachment.path,
      mimeType: attachment.mimeType,
      size: attachment.size,
    },
  }).catch(() => undefined);
};

export const cancelRemoteUpload = (machineId: string, path: string) => {
  if (!path) return;
  void window.orion?.remoteCancelUpload?.({ machineId, path }).catch(() => undefined);
};

const percentOf = (progress: RemoteUploadProgress) =>
  progress.size > 0 ? Math.min(100, Math.floor((progress.sent / progress.size) * 100)) : 100;

const routeLabel = (route: RemoteUploadProgress['route']) =>
  route === 'relay' ? 'over the internet' : route === 'lan' || route === 'direct' ? 'over your network' : null;

/**
 * How far a file got to the machine its thread runs on: a line of text and a
 * thin bar. Renders nothing for a file that isn't being sent anywhere.
 */
export const RemoteUploadStatus: React.FC<{
  machineId?: string | null;
  path: string;
  /** Offer a retry after a failure (the prompt box). */
  onRetry?: () => void;
  variant: 'chip' | 'message';
}> = ({ machineId, path, onRetry, variant }) => {
  const progress = useRemoteUpload(machineId, path);
  if (!progress) return null;
  if (variant === 'message' && progress.state === 'done') return null;
  const percent = percentOf(progress);
  const route = routeLabel(progress.route);
  if (progress.state === 'error') {
    return (
      <div
        className={`remote-upload-status remote-upload-${variant} remote-upload-failed`}
        title={`Not sent to ${progress.machineName}: ${progress.error ?? 'the upload failed.'}`}
      >
        {/* The chip is narrow: the reason is in the tooltip (and in the send error). */}
        <span className="remote-upload-text">Not sent</span>
        {onRetry && (
          <button
            type="button"
            className="remote-upload-retry"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            title="Try again"
          >
            <RotateCw size={11} />
          </button>
        )}
      </div>
    );
  }
  const done = progress.state === 'done';
  return (
    <div
      className={`remote-upload-status remote-upload-${variant}${done ? ' remote-upload-done' : ''}`}
      title={done ? `On ${progress.machineName}` : `Sending to ${progress.machineName}${route ? ` ${route}` : ''}`}
    >
      <span className="remote-upload-text">
        {done ? `On ${progress.machineName}` : `To ${progress.machineName} · ${percent}%`}
      </span>
      {!done && (
        <span className="remote-upload-bar" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </span>
      )}
    </div>
  );
};
