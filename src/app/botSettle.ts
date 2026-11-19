import type { Message, Thread } from '../store';

// A bot's settle_thread (main: src/main/bot-thread-tools.js): which threads a
// bot may settle. Only ones a bot started, never the person's own.

// The brief every bot-started thread gets (local-bots.js, bot-replies.js,
// chat/andromedus/lib/bots/tools.ts): "…it goes back to the bot "X" that asked for this."
const BOT_BRIEF_ENDING = /it goes back to the bot "[^"\n]{0,200}" that asked for this/;

const textOf = (message: Message | undefined) => (typeof message?.content === 'string' ? message.content : '');

/**
 * Whether a bot started this thread: marked when it was created
 * (`startedByBot`), else from its first messages for threads from before
 * that: Durango Code's note "Started by your bot …" (a bot on this machine),
 * or a first prompt that is a bot's brief (a cloud bot's thread, labelled
 * "Durango Chat" back then). A bot's follow-up in the person's own thread
 * never counts: only the thread's first prompt is looked at.
 */
export const threadStartedByBot = (thread: Pick<Thread, 'startedByBot'>, messages: Message[] | null | undefined) => {
  if (thread.startedByBot) return true;
  const list = messages ?? [];
  const first = list[0];
  if (first?.role === 'system' && /^Started by your bot /.test(textOf(first))) return true;
  const firstPrompt = list.find((message) => message.role === 'user');
  return Boolean(first?.role === 'system' && /^Started remotely from /.test(textOf(first)) && BOT_BRIEF_ENDING.test(textOf(firstPrompt)));
};
