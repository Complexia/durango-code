// Replies to an earlier message of a bot's thread (the Reply button under a
// message in the Bots view). The person's message starts with one quote line
// naming that message, then their text:
//
//   > **Replying to Durango** (message #42, Nov 27, 3:15 PM): the start of it…
//
//   their text
//
// It is part of the stored text, so the bot reads which message is answered
// wherever its reply runs (cloud, this machine's Claude Code or another
// harness, a kept session, its compacted history). Durango's copy, used by
// the web and iOS apps: chat/convex/botPolicy.ts (keep the two in step).
//
// Tested in scripts/test-bot-reply-quote.ts.

import { botInboxSource } from './bots';

export const BOT_REPLY_EXCERPT_CHARS = 600;
const BOT_REPLY_QUOTE = /^> \*\*Replying to ([^*\n]+)\*\* \(message #(\d+)(?:, ([^)\n]*))?\): ([^\n]*)(?:\n\n([\s\S]*))?$/;

/** The message a reply answers, as the composer holds it before sending. */
export type BotReplyTarget = { id: string; seq: number; author: string; when: string; excerpt: string };

export type BotReplyQuote = { author: string; seq: number; when: string | null; excerpt: string; text: string };

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

/** A message that starts with a reply quote: what it answers and the text after it; null otherwise. */
export const parseBotReplyQuote = (content: string): BotReplyQuote | null => {
  const match = BOT_REPLY_QUOTE.exec(content);
  if (!match) return null;
  return { author: match[1], seq: Number(match[2]), when: match[3]?.trim() || null, excerpt: match[4], text: match[5] ?? '' };
};

/** One line of a message to quote: its own reply quote dropped, Markdown and whitespace flattened, clipped. */
export const botReplyExcerpt = (content: string, max = BOT_REPLY_EXCERPT_CHARS): string => {
  const body = parseBotReplyQuote(content)?.text ?? content;
  const flat = body
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
    .replace(/^>\s?/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(flat, max);
};

/** Who wrote the quoted message, as the quote names it: the bot, "my message" (the person), or an inbox label. */
export const botReplyAuthor = (message: { role: string; authorLabel?: string | null }, botName: string): string => {
  const name =
    message.role === 'assistant'
      ? botName
      : botInboxSource(message.authorLabel) === 'person'
        ? 'my message'
        : (message.authorLabel ?? 'my message');
  return clip(name.replace(/[*\n\r]+/g, ' ').replace(/\s+/g, ' ').trim() || 'message', 80);
};

/** When the quoted message was written, as the quote says it ("Nov 27, 3:15 PM"). */
export const botReplyWhen = (createdAt: number): string => {
  try {
    return new Date(createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
};

/** The composer's reply target for a stored message. */
export const botReplyTarget = (
  message: { id: string; seq: number; role: string; content: string; authorLabel?: string | null; createdAt: number; files?: { name: string }[] },
  botName: string
): BotReplyTarget => {
  const files = message.files?.map((file) => file.name).filter(Boolean) ?? [];
  const excerpt = botReplyExcerpt(message.content) || (files.length ? `[attached: ${files.join(', ')}]` : '…');
  return { id: message.id, seq: message.seq, author: botReplyAuthor(message, botName), when: botReplyWhen(message.createdAt), excerpt: clip(excerpt, BOT_REPLY_EXCERPT_CHARS) };
};

/** `text` with the quote line of the message it replies to in front. */
export const withBotReplyQuote = (text: string, quoted: { author: string; seq: number; when?: string | null; excerpt: string }): string => {
  const author = quoted.author.replace(/[*\n\r]+/g, ' ').replace(/\s+/g, ' ').trim() || 'message';
  const when = quoted.when?.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  const excerpt = quoted.excerpt.replace(/\s+/g, ' ').trim() || '…';
  const line = `> **Replying to ${author}** (message #${Math.max(0, Math.floor(quoted.seq))}${when ? `, ${when}` : ''}): ${excerpt}`;
  const body = text.trim();
  return body ? `${line}\n\n${body}` : line;
};

/** How the quote is shown: "You" for the person's own message, the bot or inbox label otherwise. */
export const botReplyDisplayAuthor = (author: string) => (author === 'my message' ? 'You' : author);
