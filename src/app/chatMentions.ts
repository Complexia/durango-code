export type ChatMentionRange = {
  start: number;
  query: string;
};

export const hasThreadReaderSupport = (
  providerId: string | null,
  support: { providerId: string; supported: boolean } | null
) => {
  if (!providerId || !support) return false;
  return support.providerId === providerId && support.supported;
};

// Reviews, /btw asides, and /goal runs bypass the normal turn dispatcher that resolves
// @thread / @chat tokens and exposes read_thread / read_chat. Keep the Thread picker out of those
// command drafts so it cannot insert an inert reference.
export const allowsThreadMentionsInComposer = (value: string) =>
  !/^\/(?:review|btw|goal)(?:\s|$)/i.test(value.trimStart());

export const isThreadReferenceCandidate = (
  targetThreadId: string,
  selectedThreadId: string | null,
  targetIsTerminalOnly: boolean
) => targetThreadId !== selectedThreadId && !targetIsTerminalOnly;

// Thread searches may contain spaces, so there is no safe delimiter after the
// caret: text there may be unrelated draft content. Replace only the query the
// user typed before the caret. Model mentions retain their slug-like boundary.
export const getChatMentionReplaceEnd = (
  value: string,
  mention: ChatMentionRange,
  kind: 'model' | 'thread' | 'chat'
) => {
  let end = mention.start + 1 + mention.query.length;
  // Thread and Durango chat searches are free text (spaces allowed).
  if (kind !== 'model') return end;
  const continuesMention = (character: string) => /[A-Za-z0-9._:/-]/.test(character);
  while (end < value.length && continuesMention(value[end])) end += 1;
  return end;
};
