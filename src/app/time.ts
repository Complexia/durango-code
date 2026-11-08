import { type ThreadSummary } from '../store';

export const formatShortTime = (date: Date) => {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
};

export const getThreadActivityTime = (thread: {
  summary: Pick<ThreadSummary, 'lastMessage'>;
  createdAt: string;
  terminalActivityAt?: string;
}) => {
  const lastMessage = thread.summary.lastMessage;
  const transcriptTime = new Date(lastMessage?.ts ?? thread.createdAt).getTime();
  const terminalTime = thread.terminalActivityAt
    ? new Date(thread.terminalActivityAt).getTime()
    : Number.NEGATIVE_INFINITY;
  return new Date(
    Math.max(
      Number.isFinite(transcriptTime) ? transcriptTime : 0,
      Number.isFinite(terminalTime) ? terminalTime : Number.NEGATIVE_INFINITY
    )
  );
};
