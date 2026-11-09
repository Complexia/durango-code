import React, { useRef, useState } from 'react';
import {
  Check,
  CircleDashed,
  Eye,
  EyeOff,
  ExternalLink,
  Hand,
  KeyRound,
  LoaderCircle,
  Lock,
  MessageSquareReply,
  Paperclip,
  SendHorizontal,
  X,
} from 'lucide-react';
import type { FileAttachment } from '../store';
import { AttachmentThumb, formatAttachmentSize, saveFilesAsAttachments } from './attachments';
import { MarkdownContent } from './markdown';
import type { PendingUserAction } from './threadLists';

const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

type SecretAnswer = { type: 'save'; value: string } | { type: 'decline' };

/**
 * A request_secret card: the agent is waiting for a value only the user has.
 * The value lives only in this input until Save hands it to the main process,
 * which writes it to an owner-only file; the agent gets the path, never the
 * value, and nothing about it is saved with the thread. Decline tells the
 * agent to go on without it.
 */
const SecretRequestCard = ({
  action,
  currentThreadId,
  onAnswer,
}: {
  action: PendingUserAction;
  currentThreadId: string;
  onAnswer: (threadId: string, actionId: string, answer: SecretAnswer) => Promise<string | undefined>;
}) => {
  const secret = action.secret!;
  const [value, setValue] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (next: SecretAnswer) => {
    if (busy || (next.type === 'save' && !value.trim())) return;
    setBusy(true);
    setError(null);
    const failure = await onAnswer(action.threadId, action.id, next);
    setBusy(false);
    if (failure) setError(failure);
    else setValue('');
  };
  return (
    <form
      className="mt-1.5"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void answer({ type: 'save', value });
      }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[13.5px] font-medium text-[var(--text-primary)]">
            <KeyRound size={13} className="shrink-0 text-amber-300" />
            <span className="min-w-0 truncate">{secret.label}</span>
          </div>
          <div className="mt-0.5 text-[12.5px] leading-snug text-[var(--text-secondary)] [&_.markdown-content]:text-[12.5px] [&_.markdown-content>:first-child]:mt-0 [&_.markdown-content>:last-child]:mb-0">
            <MarkdownContent content={secret.reason} />
          </div>
          {action.threadId !== currentThreadId && (
            <div className="mt-0.5 truncate text-[11.5px] text-[var(--text-secondary)]">
              From subagent {action.threadTitle}
            </div>
          )}
        </div>
        {action.url && (
          <button
            type="button"
            title={action.url}
            onClick={() => void window.orion?.openExternalUrl?.(action.url!)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/15 px-2.5 py-1 text-[12px] font-medium text-[var(--text-primary)] hover:bg-white/[0.06]"
          >
            <ExternalLink size={12} />
            Open
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <input
            autoFocus
            type={revealed ? 'text' : 'password'}
            value={value}
            disabled={busy}
            placeholder={secret.placeholder ?? 'Paste or type the value'}
            aria-label={secret.label}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setValue('');
              }
            }}
            className="block w-full rounded-md border border-white/15 bg-black/20 py-1.5 pl-2.5 pr-8 font-mono text-[13px] text-[var(--text-primary)] outline-none placeholder:font-sans placeholder:text-[var(--text-secondary)] focus:border-amber-300/50 disabled:opacity-60"
          />
          <button
            type="button"
            title={revealed ? 'Hide' : 'Show'}
            aria-label={revealed ? 'Hide value' : 'Show value'}
            onClick={() => setRevealed((current) => !current)}
            className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-[var(--text-primary)]"
          >
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-300 px-2.5 py-1.5 text-[12px] font-medium text-neutral-950 hover:bg-amber-200 disabled:opacity-40 disabled:hover:bg-amber-300"
        >
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Lock size={12} />}
          Save
        </button>
        <button
          type="button"
          title="Tell the agent to go on without it"
          disabled={busy}
          onClick={() => void answer({ type: 'decline' })}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/15 px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)] hover:bg-white/[0.06] disabled:opacity-40"
        >
          <X size={12} />
          Decline
        </button>
      </div>
      {error ? (
        <div role="alert" className="mt-1 text-[11.5px] text-red-300">
          {error}
        </div>
      ) : (
        <div className="mt-1 text-[11.5px] text-[var(--text-secondary)]">
          {secret.delivery === 'ref'
            ? 'Kept by Durango Code for this thread for 24 hours. The agent can hand it to tools but never sees it.'
            : 'Saved to a private file on this computer. The agent gets only its path, never the value.'}
        </div>
      )}
    </form>
  );
};

/**
 * What the agent asked the user to do outside the chat (request_user_action),
 * pinned above the composer so it never scrolls away with the agent's
 * messages. It stays until the agent resolves it or the user marks it done;
 * the agent may keep working meanwhile. Reply clears it too and sends the
 * agent what the user wrote instead (the ask may be wrong, or they want
 * something else done); it can carry files (picked, pasted or dropped on the
 * card), such as a screenshot of where the user is stuck, which reach the
 * agent as paths it can read. Neither interrupts the agent. An action with a
 * `check` command can be watched: Durango Code runs it until it succeeds and
 * then marks the action done itself. The X dismisses a redundant action
 * (already done, superseded, asked twice) without telling the agent.
 * A secret request (request_secret) shows a private input instead.
 */
export const UserActionCards = React.memo(function UserActionCards({
  actions,
  currentThreadId,
  onDone,
  onReply,
  onDismiss,
  onWatch,
  onSecretAnswer,
}: {
  actions: PendingUserAction[];
  currentThreadId: string;
  onDone: (threadId: string, actionId: string) => void;
  onReply: (threadId: string, actionId: string, reply: string, attachments: FileAttachment[]) => void;
  onDismiss: (threadId: string, actionId: string) => void;
  onWatch: (threadId: string, actionId: string, watching: boolean) => void;
  onSecretAnswer: (threadId: string, actionId: string, answer: SecretAnswer) => Promise<string | undefined>;
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [replyFiles, setReplyFiles] = useState<FileAttachment[]>([]);
  // Saves in flight; Send waits for them so a pasted screenshot isn't lost.
  const [saving, setSaving] = useState(0);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Which reply a save belongs to: files saved after the reply was sent,
  // closed or moved to another action are dropped.
  const replyingToRef = useRef(replyingTo);
  replyingToRef.current = replyingTo;
  if (actions.length === 0) return null;
  const openReply = (key: string | null) => {
    setReplyingTo(key);
    setReply('');
    setReplyFiles([]);
  };
  const addFiles = async (key: string, files: File[]) => {
    if (files.length === 0) return;
    if (replyingToRef.current !== key) openReply(key);
    replyingToRef.current = key;
    setSaving((count) => count + 1);
    try {
      const saved = await saveFilesAsAttachments(files);
      if (saved?.length && replyingToRef.current === key) setReplyFiles((current) => [...current, ...saved]);
    } finally {
      setSaving((count) => count - 1);
    }
  };
  const canSend = saving === 0 && (reply.trim().length > 0 || replyFiles.length > 0);
  const sendReply = (action: PendingUserAction) => {
    if (!canSend) return;
    onReply(action.threadId, action.id, reply.trim(), replyFiles);
    openReply(null);
  };
  return (
    <div
      role="status"
      aria-label="Needs you"
      className="mx-auto mb-2.5 max-h-[min(40vh,360px)] max-w-[var(--chat-column-width)] overflow-auto rounded-xl border border-amber-400/30 bg-amber-400/[0.07] px-3.5 py-2.5"
    >
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-amber-300">
        <Hand size={13} className="shrink-0" />
        {actions.length === 1 ? 'Needs you' : `Needs you · ${actions.length}`}
      </div>
      {actions.map((action) => {
        const key = `${action.threadId}:${action.id}`;
        if (action.secret) {
          return (
            <SecretRequestCard key={key} action={action} currentThreadId={currentThreadId} onAnswer={onSecretAnswer} />
          );
        }
        return (
          <div
            key={key}
            className={`mt-1.5 rounded-lg ${dropTarget === key ? 'outline outline-1 outline-offset-4 outline-amber-300/60' : ''}`}
            onDragOver={(event) => {
              if (!hasFiles(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              if (dropTarget !== key) setDropTarget(key);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
            }}
            onDrop={(event) => {
              if (!hasFiles(event)) return;
              // The app's root drop handler skips a drop taken here.
              event.preventDefault();
              setDropTarget(null);
              void addFiles(key, Array.from(event.dataTransfer.files));
            }}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1 [&_.markdown-content]:text-[13.5px] [&_.markdown-content>:first-child]:mt-0 [&_.markdown-content>:last-child]:mb-0">
                <MarkdownContent content={action.action} />
                {action.threadId !== currentThreadId && (
                  <div className="mt-0.5 truncate text-[11.5px] text-[var(--text-secondary)]">
                    From subagent {action.threadTitle}
                  </div>
                )}
                {action.check && (
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
                    {action.watching ? (
                      <>
                        <CircleDashed size={12} className="shrink-0 animate-spin text-amber-300 [animation-duration:3s]" />
                        <span className="min-w-0 truncate">
                          Checking <code className="font-mono text-[11px]">{action.check}</code> until it succeeds
                        </span>
                        <button
                          type="button"
                          onClick={() => onWatch(action.threadId, action.id, false)}
                          className="shrink-0 rounded px-1 text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
                        >
                          Stop
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        title={`Run this every few seconds in ${action.checkCwd ?? 'the project'} and mark the action done when it succeeds`}
                        onClick={() => onWatch(action.threadId, action.id, true)}
                        className="inline-flex min-w-0 items-center gap-1 rounded-md border border-white/15 px-2 py-0.5 text-[11.5px] text-[var(--text-primary)] hover:bg-white/[0.06]"
                      >
                        <Eye size={12} className="shrink-0" />
                        <span className="min-w-0 truncate">
                          Watch with <code className="font-mono text-[11px]">{action.check}</code>
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                {action.url && (
                  <button
                    type="button"
                    title={action.url}
                    onClick={() => void window.orion?.openExternalUrl?.(action.url!)}
                    className="inline-flex items-center gap-1 rounded-md bg-amber-300 px-2.5 py-1 text-[12px] font-medium text-neutral-950 hover:bg-amber-200"
                  >
                    <ExternalLink size={12} />
                    Open
                  </button>
                )}
                <button
                  type="button"
                  title="Mark as done"
                  onClick={() => onDone(action.threadId, action.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2.5 py-1 text-[12px] font-medium text-[var(--text-primary)] hover:bg-white/[0.06]"
                >
                  <Check size={12} />
                  Done
                </button>
                <button
                  type="button"
                  title="Tell the agent something else instead"
                  aria-expanded={replyingTo === key}
                  onClick={() => openReply(replyingTo === key ? null : key)}
                  className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2.5 py-1 text-[12px] font-medium text-[var(--text-primary)] hover:bg-white/[0.06]"
                >
                  <MessageSquareReply size={12} />
                  Reply
                </button>
                <button
                  type="button"
                  title="Dismiss without telling the agent"
                  aria-label="Dismiss"
                  onClick={() => {
                    if (replyingTo === key) openReply(null);
                    onDismiss(action.threadId, action.id);
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-[var(--text-primary)]"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            {replyingTo === key && (
              <div className="relative mt-2">
                {(replyFiles.length > 0 || saving > 0) && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {replyFiles.map((file) => (
                      <div key={file.id} className="composer-attachment" title={file.path}>
                        <AttachmentThumb attachment={file} />
                        <span className="composer-attachment-meta">
                          <span className="composer-attachment-name">{file.name}</span>
                          <span className="composer-attachment-size">{formatAttachmentSize(file.size)}</span>
                        </span>
                        <button
                          type="button"
                          className="composer-attachment-remove"
                          title="Remove attachment"
                          aria-label={`Remove ${file.name}`}
                          onClick={() => setReplyFiles((current) => current.filter((entry) => entry.id !== file.id))}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                    {saving > 0 && (
                      <div className="flex h-[58px] items-center gap-1.5 px-2 text-[11.5px] text-[var(--text-secondary)]">
                        <LoaderCircle size={13} className="animate-spin" />
                        Attaching…
                      </div>
                    )}
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    // Let the same file be picked again after it is removed.
                    event.currentTarget.value = '';
                    void addFiles(key, files);
                  }}
                />
                <textarea
                  autoFocus
                  rows={2}
                  value={reply}
                  placeholder="Tell the agent what to do instead…"
                  aria-label="Reply to the agent"
                  onChange={(event) => setReply(event.target.value)}
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.files);
                    if (files.length === 0) return;
                    event.preventDefault();
                    void addFiles(key, files);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      sendReply(action);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      openReply(null);
                    }
                  }}
                  className="block w-full resize-none rounded-md border border-white/15 bg-black/20 py-1.5 pl-2.5 pr-[4.25rem] text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)] focus:border-amber-300/50"
                />
                <button
                  type="button"
                  title="Attach files (or paste or drop them here)"
                  aria-label="Attach files"
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute bottom-1.5 right-8 inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-[var(--text-primary)]"
                >
                  <Paperclip size={13} />
                </button>
                <button
                  type="button"
                  title="Send (Enter)"
                  aria-label="Send reply"
                  disabled={!canSend}
                  onClick={() => sendReply(action)}
                  className="absolute bottom-1.5 right-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-amber-300 text-neutral-950 hover:bg-amber-200 disabled:opacity-40 disabled:hover:bg-amber-300"
                >
                  <SendHorizontal size={13} />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
