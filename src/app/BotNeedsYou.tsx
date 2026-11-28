import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, Check, CheckCircle2, LoaderCircle, MessageCircleQuestion, X } from 'lucide-react';
import { toast } from 'sonner';
import { useOrionStore, type FileAttachment } from '../store';
import { relativeBotTime, requestResolutionActor, requestResolutionLabel } from './bots';
import {
  botNeedsYouCards,
  botResolvedRequests,
  botSentAnswers,
  visibleResolvedBotCards,
  type BotNeedsYouCard,
  type BotResolvedCard,
  type BotThreadRequest,
  type SentBotAnswer,
} from './botThreadRequests';
import { sealBotSecret } from './botSecretSeal';
import { MarkdownContent } from './markdown';
import type { PendingUserAction } from './threadLists';
import { UserActionCards } from './UserActions';

type SecretAnswer = { type: 'save'; value: string } | { type: 'decline' };

/** The thread view's card handlers (App.tsx): they act on a card of a thread here or mirrored here. */
export type UserActionHandlers = {
  onDone: (threadId: string, actionId: string) => void;
  onReply: (threadId: string, actionId: string, reply: string, attachments: FileAttachment[]) => void;
  onDismiss: (threadId: string, actionId: string) => void;
  onWatch: (threadId: string, actionId: string, watching: boolean) => void;
  onSecretAnswer: (threadId: string, actionId: string, answer: SecretAnswer) => Promise<string | undefined>;
};

const cardKey = (threadId: string, actionId: string) => `${threadId}\n${actionId}`;

/** A request_secret value, at most (main's SECRET_VALUE_MAX_CHARS). */
const SECRET_VALUE_MAX_CHARS = 16_384;

const ANSWER_LABEL: Record<string, string> = {
  done: 'Marked done',
  reply: 'Replied',
  dismiss: 'Dismissed',
  save: 'Value sent',
  decline: 'Declined',
};

const plainLine = (text: string) =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A bot's "Needs you" panel, above its composer: the cards of the threads it
 * started that wait on the person, the same cards those threads pin above
 * their own prompt box. A card of a thread on (or mirrored to) this computer
 * acts on it directly, exactly as in the thread; one of a thread on another
 * machine goes to that machine through Durango (a secret's value sealed so
 * only that machine opens it). Once resolved (from here, from the thread, or
 * via answer_thread_request), a calm resolved confirmation appears briefly
 * until dismissed or superseded by a newer bot message.
 */
export const BotNeedsYouPanel: React.FC<{
  botId: string;
  requests: BotThreadRequest[] | undefined;
  resolvedRequests?: BotThreadRequest[];
  latestAssistantAt?: number;
  handlers: UserActionHandlers | undefined;
  /** Called right after an answer is sent so the thread view polls immediately for the stamped inbox card. */
  onAnswered?: () => void;
  /** Opens a thread here in the usual thread view; false when it isn't on this computer. */
  onOpenThread: (threadId: string) => boolean;
}> = ({ botId, requests, resolvedRequests, latestAssistantAt, handlers, onAnswered, onOpenThread }) => {
  const threads = useOrionStore((state) => state.threads);
  const cards = useMemo(() => botNeedsYouCards(botId, requests, threads), [botId, requests, threads]);
  // Answered from here through Durango: shown as sent (and the sidebar stops
  // highlighting the bot) until the card leaves Durango's list, so an offline
  // machine's "reaches it when it is back" stays until it took the answer.
  // (BotsWorkspace reconciles it against every listed bot's cards.)
  const sent = useSyncExternalStore(botSentAnswers.subscribe, botSentAnswers.get);
  const localResolved = useSyncExternalStore(botResolvedRequests.subscribe, botResolvedRequests.get);
  const [dismissedResolved, setDismissedResolved] = useState<ReadonlySet<string>>(() => new Set());
  const byAction = useMemo(() => new Map(cards.map((card) => [cardKey(card.action.threadId, card.action.id), card])), [cards]);
  const activeKeys = useMemo(() => new Set(cards.map((card) => card.key)), [cards]);
  const resolvedCards = useMemo(
    () =>
      visibleResolvedBotCards({
        botId,
        resolvedRequests,
        localResolved,
        activeKeys,
        dismissed: dismissedResolved,
        latestAssistantAt,
      }),
    [activeKeys, botId, dismissedResolved, latestAssistantAt, localResolved, resolvedRequests]
  );

  const answering = cards.filter((card) => card.request?.status === 'answering' || sent.has(card.key));
  const actionable = cards.filter((card) => card.kind !== 'input' && !answering.includes(card));
  const inputs = cards.filter((card) => card.kind === 'input');

  const markSent = (card: BotNeedsYouCard, entry: SentBotAnswer | null) => botSentAnswers.set(card.key, entry);

  /** Done / Reply / Dismiss / a secret for a thread elsewhere, through Durango. */
  const answerRemotely = async (card: BotNeedsYouCard, op: 'done' | 'reply' | 'dismiss' | 'save' | 'decline', extra: { reply?: string; sealed?: string } = {}) => {
    const request = card.request;
    if (!request) return 'That request is not on Durango yet: try again in a moment.';
    // Until Durango says when it took it, no earlier error of the card can undo it.
    markSent(card, { op, machineName: request.machineName, online: true, at: Number.MAX_SAFE_INTEGER });
    type AnswerResult = { ok: boolean; error?: string; machineName?: string | null; online?: boolean; at?: number };
    const result: AnswerResult | undefined = await window.orion
      ?.answerBotThreadRequest?.({ requestId: request.id, op, ...extra })
      .catch((error: unknown): AnswerResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (!result?.ok) {
      markSent(card, null);
      return result?.error ?? 'It could not be sent.';
    }
    markSent(card, {
      op,
      machineName: result.machineName ?? request.machineName,
      online: result.online !== false,
      ...(typeof result.at === 'number' ? { at: result.at } : {}),
    });
    onAnswered?.();
    return undefined;
  };
  const failLoudly = (error: string | undefined) => {
    if (error) toast.error(error);
  };

  const route = (threadId: string, actionId: string) => byAction.get(cardKey(threadId, actionId));

  const panelHandlers = {
    onDone: (threadId: string, actionId: string) => {
      const card = route(threadId, actionId);
      if (!card) return;
      if (card.here) handlers?.onDone(threadId, actionId);
      else void answerRemotely(card, 'done').then(failLoudly);
    },
    onReply: (threadId: string, actionId: string, reply: string, attachments: FileAttachment[]) => {
      const card = route(threadId, actionId);
      if (!card) return;
      if (card.here) handlers?.onReply(threadId, actionId, reply, attachments);
      else void answerRemotely(card, 'reply', { reply }).then(failLoudly);
    },
    onDismiss: (threadId: string, actionId: string) => {
      const card = route(threadId, actionId);
      if (!card) return;
      if (card.here) handlers?.onDismiss(threadId, actionId);
      else void answerRemotely(card, 'dismiss').then(failLoudly);
    },
    onWatch: (threadId: string, actionId: string, watching: boolean) => {
      const card = route(threadId, actionId);
      if (card?.here) handlers?.onWatch(threadId, actionId, watching);
    },
    onSecretAnswer: async (threadId: string, actionId: string, answer: SecretAnswer) => {
      const card = route(threadId, actionId);
      if (!card) return 'That request was answered already.';
      if (card.here) return (await handlers?.onSecretAnswer(threadId, actionId, answer)) ?? undefined;
      if (answer.type === 'decline') return answerRemotely(card, 'decline');
      if (answer.value.length > SECRET_VALUE_MAX_CHARS) return 'That value is too long.';
      const key = card.request?.secretKey;
      if (!key) return 'Enter it in the thread on that computer.';
      let sealed: string;
      try {
        sealed = await sealBotSecret(key, actionId, answer.value);
      } catch {
        return 'The value could not be sealed for that computer.';
      }
      return answerRemotely(card, 'save', { sealed });
    },
  };

  const openThreadButton = (threadId: string, machineName: string | null, here = false) => (
    <button
      type="button"
      title={here || threads.some((thread) => thread.id === threadId) ? 'Open the thread' : `The thread runs on ${machineName ?? 'another computer'}`}
      onClick={() => {
        if (!onOpenThread(threadId)) toast.message(`That thread runs on ${machineName ?? 'another computer'}: open it in Durango Code there.`);
      }}
      className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[11.5px] text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
    >
      Open thread
      <ArrowUpRight size={11} />
    </button>
  );

  const sourceLine = (card: BotNeedsYouCard) => (
    <>
      <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11.5px] text-[var(--text-secondary)]">
        <span className="min-w-0 truncate">
          From <span className="text-[var(--text-primary)]/80">{card.threadTitle}</span>
          {card.machineName ? ` · ${card.machineName}` : ''}
          {card.action.threadTitle && card.action.threadId !== card.threadId ? ` · subagent ${card.action.threadTitle}` : ''}
        </span>
        {openThreadButton(card.threadId, card.machineName, card.here)}
      </div>
      {card.request?.error && (
        <div role="alert" className="mt-0.5 text-[11.5px] text-red-300">
          {card.request.error}
        </div>
      )}
    </>
  );

  const dismissResolved = (card: BotResolvedCard) => {
    setDismissedResolved((current) => new Set(current).add(card.dismissKey));
  };

  const resolvedRow = (card: BotResolvedCard) => {
    const dismissed = card.resolved.op === 'dismiss';
    const label = requestResolutionLabel(card.resolved);
    const actor = requestResolutionActor(card.resolved);
    return (
      <div key={card.key} className="flex min-w-0 items-start gap-2 text-[12px]">
        {dismissed ? (
          <X size={13} className="mt-0.5 shrink-0 text-neutral-400" />
        ) : (
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className={dismissed ? 'font-medium text-neutral-300' : 'font-medium text-emerald-300'}>{label}</span>
            <span className="text-[11px] text-[var(--text-secondary)]">
              · {actor} · {relativeBotTime(card.resolved.at)}
            </span>
          </div>
          <div className="truncate text-[12px] text-[var(--text-primary)]/80">{plainLine(card.text)}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-secondary)]">
            <span className="min-w-0 truncate">
              From <span className="text-[var(--text-primary)]/75">{card.threadTitle}</span>
              {card.machineName ? ` · ${card.machineName}` : ''}
            </span>
            {openThreadButton(card.threadId, card.machineName)}
          </div>
        </div>
        <button
          type="button"
          title="Dismiss confirmation"
          aria-label="Dismiss confirmation"
          onClick={() => dismissResolved(card)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-[var(--text-primary)]"
        >
          <X size={13} />
        </button>
      </div>
    );
  };

  if (cards.length === 0) {
    if (resolvedCards.length === 0) return null;
    const allDismissed = resolvedCards.every((card) => card.resolved.op === 'dismiss');
    return (
      <div className="shrink-0 px-4 pt-2 [--chat-column-width:760px]">
        <div
          role="status"
          aria-label="Request resolved"
          className={`mx-auto max-h-[min(30vh,220px)] w-full max-w-[var(--chat-column-width,760px)] overflow-auto rounded-xl border px-3.5 py-2 ${
            allDismissed
              ? 'border-white/[0.09] bg-white/[0.03]'
              : 'border-emerald-400/25 bg-emerald-400/[0.06]'
          }`}
        >
          <div className="divide-y divide-white/[0.06]">
            {resolvedCards.map((card) => (
              <div key={card.key} className="py-1.5 first:pt-0.5 last:pb-0.5">
                {resolvedRow(card)}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const extra = (
    <>
      {inputs.map((card) => (
        <div key={card.key} className="mt-1.5 flex items-start gap-3">
          <MessageCircleQuestion size={14} className="mt-0.5 shrink-0 text-amber-300" />
          <div className="min-w-0 flex-1 [&_.markdown-content]:text-[13.5px] [&_.markdown-content>:first-child]:mt-0 [&_.markdown-content>:last-child]:mb-0">
            <MarkdownContent content={card.action.action} />
            {sourceLine(card)}
          </div>
          <span className="shrink-0 pt-0.5 text-[11.5px] text-[var(--text-secondary)]">Answer it in the thread</span>
        </div>
      ))}
      {answering.map((card) => {
        const local = sent.get(card.key);
        const op = local?.op ?? card.request?.answer ?? 'done';
        const machine = local?.machineName ?? card.machineName ?? 'its computer';
        const offline = local ? !local.online : false;
        return (
          <div key={card.key} className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
            {offline ? <Check size={12} className="shrink-0 text-amber-300" /> : <LoaderCircle size={12} className="shrink-0 animate-spin text-amber-300" />}
            <span className="min-w-0 truncate">
              {ANSWER_LABEL[op] ?? 'Answered'}: <span className="text-[var(--text-primary)]/80">{card.request?.secretLabel ?? card.action.action.split('\n')[0]}</span>
              {offline ? ` · reaches ${machine} when it is back online` : ` · sending to ${machine}…`}
            </span>
          </div>
        );
      })}
      {resolvedCards.map((card) => (
        <div key={card.key} className="mt-2 border-t border-amber-400/15 pt-2">
          {resolvedRow(card)}
        </div>
      ))}
    </>
  );

  const actions: PendingUserAction[] = actionable.map((card) => card.action);
  return (
    <div className="shrink-0 px-4 pt-2 [--chat-column-width:760px] [&>div]:mb-0">
      <UserActionCards
        actions={actions}
        currentThreadId=""
        onDone={panelHandlers.onDone}
        onReply={panelHandlers.onReply}
        onDismiss={panelHandlers.onDismiss}
        onWatch={panelHandlers.onWatch}
        onSecretAnswer={panelHandlers.onSecretAnswer}
        source={(action) => {
          const card = route(action.threadId, action.id);
          return card ? sourceLine(card) : null;
        }}
        allowFiles={(action) => route(action.threadId, action.id)?.here === true}
        secretNote={(action) => {
          const card = route(action.threadId, action.id);
          if (!card || card.here) return undefined;
          return `Sealed for ${card.machineName ?? 'its computer'}: only that computer can open it. Your bot never sees it.`;
        }}
        secretUnavailable={(action) => {
          const card = route(action.threadId, action.id);
          if (!card || card.here || card.request?.secretKey) return undefined;
          return `Enter it in the thread on ${card.machineName ?? 'its computer'}: its Durango Code needs an update to take it from here.`;
        }}
        extra={extra}
        extraCount={inputs.length + answering.length + resolvedCards.length}
      />
    </div>
  );
};
