import type { OrionMcpEntry } from '../types';

// Shared helpers for MCP servers connected to Orion: the @nickname mention
// token, the prompt context that points the agent at a mentioned server, and
// the Settings form's parsing.

type MentionableMcp = Pick<OrionMcpEntry, 'id' | 'nickname' | 'enabled'>;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Same boundary rule as model mentions: "@durango-dev" never also matches "@durango".
export const parseMcpMentions = <T extends MentionableMcp>(text: string, servers: T[]): T[] => {
  if (!text.includes('@')) return [];
  return servers.filter((server) =>
    new RegExp(`(?:^|\\s)@${escapeRegExp(server.nickname)}(?![A-Za-z0-9._:/-])`, 'i').test(text)
  );
};

// Thread attachments are sticky: a server mentioned once stays loaded for the
// thread's later turns until it is detached. Ids of deleted servers drop out.
export const mergeMcpAttachments = (
  current: string[] | undefined,
  mentioned: MentionableMcp[],
  servers: MentionableMcp[]
) => {
  const known = new Set(servers.map((server) => server.id));
  const next = [...(current ?? []), ...mentioned.map((server) => server.id)].filter(
    (id, index, all) => known.has(id) && all.indexOf(id) === index
  );
  return next;
};

// Context block prepended when the user @-mentions Orion MCP servers.
export const buildMcpMentionsContext = (mentions: MentionableMcp[]) =>
  [
    '[MCP mentions]',
    'The user referenced these MCP servers with @-mentions and wants you to use them for this request. Durango Code requests these connections under their nicknames when the provider supports them; available tools are named after the server (for example mcp__<nickname>__<tool>, <nickname>.<tool>, or a provider-prefixed equivalent). Prefer these tools over reimplementing what they do; if one is missing from your tool list, say so instead of guessing.',
    ...mentions.map((server) => `- @${server.nickname} → MCP server "${server.nickname}"`),
    '[/MCP mentions]',
  ].join('\n');

// "mcp.durango.sh/mcp" → "durango"; "developers.openai.com/mcp" → "openai".
export const suggestMcpNickname = (source: string, transport: 'http' | 'stdio') => {
  const clean = (value: string) =>
    value
      .toLowerCase()
      .replace(/^@[^/]+\//, '')
      .replace(/^(?:mcp-server-|server-|mcp-)/, '')
      .replace(/(?:-mcp-server|-mcp|-server)$/, '')
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 32);
  if (transport === 'http') {
    try {
      const host = new URL(source.trim()).hostname;
      const parts = host.split('.').filter(Boolean);
      if (parts.length === 0) return '';
      return clean(parts.length >= 2 ? parts[parts.length - 2] : parts[0]);
    } catch {
      return '';
    }
  }
  const words = splitCommandLine(source);
  const executable = words[0]?.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '') ?? '';
  // Argument values can be credentials. Only recognize an unambiguous
  // package position in common launchers; unknown options fall back to the
  // executable instead of guessing which later argument names the server.
  if (['npx', 'bunx', 'uvx'].includes(executable.toLowerCase())) {
    let index = 1;
    if (executable.toLowerCase() !== 'uvx') {
      while (['-y', '--yes', '--no-install'].includes(words[index])) index += 1;
    }
    const packageName = words[index]?.match(/^(?:@[a-z0-9._-]+\/)?([a-z0-9][a-z0-9._-]*)(?:@[^/\s]+)?$/i);
    if (packageName) return clean(packageName[1]);
  }
  return clean(executable);
};

// Split argv without invoking a shell. Windows paths keep their backslashes;
// only a backslash run before a double quote follows Windows argv escaping.
export const splitCommandLine = (
  value: string,
  windows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)
) => {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasWord = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (windows && char === '\\' && quote !== "'") {
      let end = index;
      while (value[end] === '\\') end += 1;
      const count = end - index;
      if (value[end] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) current += '"';
        else quote = quote === '"' ? null : '"';
        index = end;
      } else {
        current += '\\'.repeat(count);
        index = end - 1;
      }
      hasWord = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && /[\\"$`]/.test(value[index + 1] ?? '')) current += value[++index];
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasWord = true;
    } else if (char === '\\' && index + 1 < value.length) {
      current += value[++index];
      hasWord = true;
    } else if (/\s/.test(char)) {
      if (hasWord) words.push(current);
      current = '';
      hasWord = false;
    } else {
      current += char;
      hasWord = true;
    }
  }
  if (hasWord) words.push(current);
  return words;
};

// "Name: value" lines (headers) or "KEY=value" lines (environment).
export const parseKeyValueLines = (value: string, separator: ':' | '=') => {
  const entries: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(separator);
    if (index <= 0) {
      return { ok: false as const, error: `“${trimmed.slice(0, 40)}” needs a ${separator === ':' ? 'Name: value' : 'KEY=value'} pair.` };
    }
    entries[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return { ok: true as const, entries };
};
