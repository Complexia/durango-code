import React from 'react';
import { Check, ExternalLink, Hand } from 'lucide-react';
import { MarkdownContent } from './markdown';
import type { PendingUserAction } from './threadLists';

/**
 * What the agent asked the user to do outside the chat (request_user_action),
 * pinned above the composer so it never scrolls away with the agent's
 * messages. It stays until the agent resolves it or the user marks it done;
 * the agent may keep working meanwhile.
 */
export const UserActionCards = React.memo(function UserActionCards({
  actions,
  currentThreadId,
  onDone,
}: {
  actions: PendingUserAction[];
  currentThreadId: string;
  onDone: (threadId: string, actionId: string) => void;
}) {
  if (actions.length === 0) return null;
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
      {actions.map((action) => (
        <div key={`${action.threadId}:${action.id}`} className="mt-1.5 flex items-start gap-3">
          <div className="min-w-0 flex-1 [&_.markdown-content]:text-[13.5px] [&_.markdown-content>:first-child]:mt-0 [&_.markdown-content>:last-child]:mb-0">
            <MarkdownContent content={action.action} />
            {action.threadId !== currentThreadId && (
              <div className="mt-0.5 truncate text-[11.5px] text-[var(--text-secondary)]">
                From subagent {action.threadTitle}
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
          </div>
        </div>
      ))}
    </div>
  );
});
