// A bot reply is every text block Claude Code writes, including text before a
// tool call: a bot that writes its update, calls show_actions, then writes the
// whole update again would post it twice. A block a later block repeats is
// left out (only when that later block stays shown and says all of it);
// progress lines ("Checking that now.") nothing repeats stay as they are.
// Durango's copy (cloud replies, where cards sit between blocks):
// chat/andromedus/lib/bots/reply-repeats.ts.

const SHORT_BLOCK_WORDS = 8;
const SHARED_TRIGRAMS = 0.5;

const blockOf = (text) => {
  const tokens = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const trigrams = new Set();
  for (let index = 0; index + 3 <= tokens.length; index += 1) trigrams.add(tokens.slice(index, index + 3).join(' '));
  // The words that carry meaning: names, ids, numbers, anything 4+ letters.
  return { tokens, all: new Set(tokens), trigrams, words: new Set(tokens.filter((token) => token.length >= 4 || /\d/.test(token))) };
};

/**
 * Whether `later` says all of what `earlier` says: a short block when the
 * later one opens with it; a longer one when every word that carries meaning
 * is in the later one (a report about another service, id or number isn't a
 * repeat) and most of its phrasing too.
 */
const repeats = (earlier, later) => {
  if (!earlier.tokens.length || later.tokens.length < earlier.tokens.length) return false;
  if (earlier.tokens.length < SHORT_BLOCK_WORDS) return earlier.tokens.every((token, index) => later.tokens[index] === token);
  for (const word of earlier.words) if (!later.all.has(word)) return false;
  let shared = 0;
  for (const gram of earlier.trigrams) if (later.trigrams.has(gram)) shared += 1;
  return shared / earlier.trigrams.size >= SHARED_TRIGRAMS;
};

export const blockRepeats = (earlier, later) => repeats(blockOf(earlier), blockOf(later));

/** For each block: the index of the later block, still shown, that repeats it (so it is left out), or null. */
export const repeatedBy = (texts) => {
  const blocks = texts.map(blockOf);
  const by = texts.map(() => null);
  for (let earlier = blocks.length - 2; earlier >= 0; earlier -= 1) {
    for (let later = earlier + 1; later < blocks.length; later += 1) {
      if (by[later] === null && repeats(blocks[earlier], blocks[later])) {
        by[earlier] = later;
        break;
      }
    }
  }
  return by;
};

/** A reply's finished text blocks as the person sees them: trimmed, repeats left out, a blank line between. */
export const replyTextOf = (blocks) => {
  const texts = blocks.map((block) => String(block ?? '').trim()).filter(Boolean);
  const by = repeatedBy(texts);
  return texts.filter((_, index) => by[index] === null).join('\n\n');
};

/**
 * A streaming reply's text: its finished blocks (collapsed once per new
 * block, not per streamed chunk) and the block streaming now, shown as it
 * comes. → { text(blocks, partial) }
 */
export const createReplyText = () => {
  let seen = null; // the blocks `finished` was made from (the runner may clear and refill its list)
  let finished = '';
  return {
    text(blocks, partial = '') {
      if (!seen || seen.length !== blocks.length || blocks.some((block, index) => block !== seen[index])) {
        seen = [...blocks];
        finished = replyTextOf(blocks);
      }
      return [finished, String(partial ?? '').trim()].filter(Boolean).join('\n\n');
    },
  };
};
