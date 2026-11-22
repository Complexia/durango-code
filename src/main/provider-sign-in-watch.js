import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Provider sign-ins done outside Durango Code (`agy` → /logout and back in,
// `codex login`, `grok login` in a terminal) change the account, and with it
// the models, but nothing tells Durango: its model catalog stays cached until
// it expires. Each CLI keeps its sign-in in a file, so when a window regains
// focus (the user coming back from the terminal) the files' modification
// times are compared with the last look, and a change refreshes that
// provider's models and status. A few stats per focus, nothing in the
// background.

const home = () => os.homedir();

/** providerId → the files its CLI rewrites on sign-in or sign-out. */
export const providerSignInFiles = () => ({
  antigravity: [path.join(home(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')],
  codex: [path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'auth.json')],
  grok: [path.join(process.env.GROK_HOME || path.join(home(), '.grok'), 'auth.json')],
  // Linux and Windows; on macOS Claude Code keeps its sign-in in the keychain.
  claude: [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude'), '.credentials.json')],
  opencode: [path.join(process.env.XDG_DATA_HOME || path.join(home(), '.local', 'share'), 'opencode', 'auth.json')],
});

const fingerprint = async (files) => {
  const parts = await Promise.all(
    files.map(async (file) => {
      try {
        const stat = await fs.stat(file);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return 'missing';
      }
    })
  );
  return parts.join('|');
};

/**
 * `onChange(providerIds)` runs when any provider's sign-in files changed
 * since the previous check. The first check only records the baseline.
 */
export const createProviderSignInWatch = ({ onChange, files = providerSignInFiles, minIntervalMs = 2000 }) => {
  let last = null;
  let lastCheckAt = 0;
  let checking = null;
  const check = async () => {
    if (checking) return checking;
    if (last && Date.now() - lastCheckAt < minIntervalMs) return [];
    lastCheckAt = Date.now();
    checking = (async () => {
      const entries = await Promise.all(
        Object.entries(files()).map(async ([providerId, list]) => [providerId, await fingerprint(list)])
      );
      const next = Object.fromEntries(entries);
      const changed = last ? entries.filter(([providerId, value]) => last[providerId] !== value).map(([id]) => id) : [];
      last = next;
      if (changed.length) {
        try {
          onChange(changed);
        } catch {}
      }
      return changed;
    })().finally(() => {
      checking = null;
    });
    return checking;
  };
  return { check };
};
