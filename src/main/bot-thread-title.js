// The title of a Durango Code thread a bot starts in a project (delegate_task
// `project`). The bot names the task itself and tends to borrow a commit-style
// area prefix ("Bots: settle finished threads", "<bot name>: …"). Threads get
// a plain, descriptive title like any other, so that prefix is dropped; the
// thread still says which bot started it.

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const botThreadTitle = (title, botName) => {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim();
  const name = String(botName ?? '').replace(/\s+/g, ' ').trim();
  // The bot's own name first, so a bot named "Bot - QA" loses all of it.
  const prefixes = [...(name ? [escapeRegExp(name)] : []), 'bots?'];
  // "Bots: …", "Bot - …", "Durango: …" (a separator then a space, so
  // "Bot-started threads" or "Durango Code: …" stay as they are).
  const stripped = text.replace(new RegExp(`^(?:${prefixes.join('|')})\\s*[:·–—-]\\s+`, 'iu'), '');
  if (!stripped || stripped === text) return text;
  // By code point, so a letter outside the BMP is capitalized whole.
  const [first] = stripped;
  return first.toUpperCase() + stripped.slice(first.length);
};
