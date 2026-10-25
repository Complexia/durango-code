// Naming for the Durango workspace a thread's first turn creates
// (docs/workspaces.md). `durango-code ws` names are 1-48 lowercase letters,
// digits, '-' or '_', starting with a letter or digit.

const NAME_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'can', 'could', 'do', 'for', 'from', 'how', 'i', 'in', 'is',
  'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'please', 'so', 'that', 'the', 'this', 'to', 'we',
  'what', 'when', 'with', 'would', 'you', 'your',
]);

/** A readable, unique-enough workspace name from the thread's first message (or title). */
export const durangoWorkspaceName = (seed: string, random: () => number = Math.random) => {
  const words = seed
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/[\s-]+/)
    .filter((word) => word && !NAME_STOPWORDS.has(word))
    .slice(0, 4);
  const base = words.join('-').slice(0, 36).replace(/-+$/, '') || 'thread';
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${base}-${suffix}`;
};
