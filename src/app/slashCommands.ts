import type { SlashCommandInfo } from '../types';

// The composer's slash-command menu. Claude-backed threads show the real
// command list reported by the CLI (agent:slashCommands / listSlashCommands);
// until one arrives the fallback below seeds the menu. Orion-native commands
// ride the same menu so it is the single discovery surface.

export type SlashCommandCandidate = {
  command: SlashCommandInfo;
  /** orion: handled by Orion itself; claude/antigravity: expanded CLI-side as prompt text. */
  source: 'orion' | 'claude' | 'antigravity';
};

type OrionSlashCommand = SlashCommandInfo & {
  /** Which composer contexts list the command. */
  appliesTo: (context: SlashCommandContext) => boolean;
};

export type SlashCommandContext = {
  providerId: string | null;
  /** Thread resolves to a Claude SDK session (claude provider, or Orion orchestrator on a Claude main driver). */
  claudeBacked: boolean;
  /** Embedded Claude Code CLI (PTY) thread — text is delivered verbatim to the TUI. */
  isTerminal: boolean;
};

export type CodexReviewRequest = {
  mode: 'uncommitted' | 'base' | 'commit' | 'custom';
  base?: string;
  commit?: string;
  instructions?: string;
};

export type ParsedCodexReviewCommand =
  | { review: CodexReviewRequest; error?: never }
  | { review?: never; error: string };

/**
 * Parse Orion's native Codex `/review` command without depending on composer
 * state. Remote controllers use the same syntax as the local composer, so the
 * host can route either entry point into Codex's dedicated review API.
 */
export const parseCodexReviewCommand = (value: string): ParsedCodexReviewCommand | null => {
  const match = value.trim().match(/^\/review(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  const rest = match[1]?.trim() ?? '';
  if (!rest) return { review: { mode: 'uncommitted' } };

  const baseMatch = rest.match(/^base(?:\s+(\S+))?$/i);
  if (baseMatch) {
    return baseMatch[1]
      ? { review: { mode: 'base', base: baseMatch[1] } }
      : { error: 'Name a base branch, e.g. “/review base main”.' };
  }

  const commitMatch = rest.match(/^commit(?:\s+([0-9a-fA-F]{4,40}))?$/i);
  if (commitMatch) {
    return commitMatch[1]
      ? { review: { mode: 'commit', commit: commitMatch[1] } }
      : { error: 'Name a commit, e.g. “/review commit abc1234”.' };
  }

  return { review: { mode: 'custom', instructions: rest } };
};

/**
 * Claude only expands slash commands when the prompt begins with `/`. Keep
 * Orion-owned context without moving it ahead of the command; ordinary
 * prompts retain the established context-first ordering.
 */
export const addPromptContext = (
  prompt: string,
  context: string,
  preserveSlashCommandStart: boolean
): string => {
  if (!context) return prompt;
  if (!prompt) return context;
  if (preserveSlashCommandStart && prompt.trimStart().startsWith('/')) {
    return `${prompt.trimStart()}\n\n${context}`;
  }
  return `${context}\n\n${prompt}`;
};

export const ORION_SLASH_COMMANDS: OrionSlashCommand[] = [
  {
    name: 'goal',
    description: 'Set a persistent goal the agent pursues across turns',
    argumentHint: '<objective> [budget:500k] | pause | resume | clear | status',
    appliesTo: ({ providerId, isTerminal }) => providerId === 'codex' && !isTerminal,
  },
  {
    name: 'review',
    description: 'Review code changes (uncommitted, against a base branch, or a commit)',
    argumentHint: '[uncommitted | base <branch> | commit <sha> | <instructions>]',
    appliesTo: ({ providerId, isTerminal }) => providerId === 'codex' && !isTerminal,
  },
  {
    name: 'btw',
    description: 'Ask a side question without interrupting or polluting the agent',
    argumentHint: '<question>',
    appliesTo: ({ claudeBacked, isTerminal }) => claudeBacked && !isTerminal,
  },
  {
    name: 'clear',
    description: 'Start a fresh session — next message begins with empty context',
    argumentHint: '',
    appliesTo: ({ claudeBacked, isTerminal }) => claudeBacked && !isTerminal,
  },
  {
    name: 'model',
    description: 'Switch the model for this thread',
    argumentHint: '',
    appliesTo: ({ isTerminal }) => !isTerminal,
  },
];

// Seed list shown before any Claude session has reported its real commands.
// Fully replaced (not merged) once live data lands — usually within a couple
// of seconds, since a cold pull now triggers a main-side harvest boot.
// Generated from a real supportedCommands() call against Claude Code v2.1.x
// with no user/project settings (descriptions trimmed to their first line);
// re-harvest to refresh after CLI upgrades.
export const CLAUDE_BUILTIN_FALLBACK: SlashCommandInfo[] = [
  { name: 'batch', description: 'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR.', argumentHint: '<instruction>' },
  { name: 'claude-api', description: 'Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration.', argumentHint: '' },
  { name: 'clear', description: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)', argumentHint: '[name]', aliases: ['reset', 'new'] },
  { name: 'code-review', description: 'Review the current diff for correctness bugs and reuse/simplification/efficiency cleanups at the given effort level (low/medium: fewer, high-confidence…', argumentHint: '[low|medium|high|xhigh|max|ultra] [--fix] [--comment] [<target>]' },
  { name: 'color', description: 'Set the prompt bar color for this session', argumentHint: '[red|blue|green|yellow|purple|orange|pink|cyan|default]' },
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>' },
  { name: 'config', description: 'Set a setting by key', argumentHint: 'key=value', aliases: ['settings'] },
  { name: 'context', description: 'Show current context usage', argumentHint: '' },
  { name: 'dataviz', description: 'Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization, in ANY output medium — an HTML or React artifact,…', argumentHint: '' },
  { name: 'debug', description: 'Enable debug logging for this session and help diagnose issues', argumentHint: '[issue description]' },
  { name: 'deep-research', description: 'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report. (dynamic workflow)', argumentHint: '' },
  { name: 'design', description: 'Grant or revoke Claude agent access to your Design projects', argumentHint: 'consent | revoke' },
  { name: 'design-consent', description: 'Grant Claude agent access to your Design projects', argumentHint: '' },
  { name: 'design-revoke', description: 'Revoke Claude agent access to your Design projects', argumentHint: '' },
  { name: 'design-sync', description: 'Push a React design system to claude.ai/design. This runs a converter that bundles the real component code (from Storybook or a bare package) and uploads it.…', argumentHint: '[<project hint, e.g. "Acme DS">]' },
  { name: 'doctor', description: 'Health-check the user\'s Claude Code setup and fix issues: diagnose installation health — what the `claude doctor` terminal diagnostics cover — from local data…', argumentHint: '', aliases: ['checkup'] },
  { name: 'effort', description: 'Set effort level for model usage', argumentHint: '<low|medium|high|xhigh|max|ultracode|auto>' },
  { name: 'extra-usage', description: 'Renamed to /usage-credits', argumentHint: '' },
  { name: 'fast', description: 'Toggle fast mode (Opus 5)', argumentHint: '[on|off]' },
  { name: 'fewer-permission-prompts', description: 'Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce permission…', argumentHint: '' },
  { name: 'goal', description: 'Set a goal — keep working until the condition is met', argumentHint: '' },
  { name: 'heapdump', description: 'Dump the JS heap to ~/Desktop', argumentHint: '' },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation', argumentHint: '' },
  { name: 'insights', description: 'Generate a report analyzing your Claude Code sessions', argumentHint: '' },
  { name: 'loop', description: 'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.', argumentHint: '[interval] [prompt]', aliases: ['proactive'] },
  { name: 'mcp', description: 'Manage MCP servers', argumentHint: '[reconnect|enable|disable [<server>|all]]' },
  { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '<model>' },
  { name: 'recap', description: 'Generate a one-line session recap now', argumentHint: '' },
  { name: 'reload-skills', description: 'Pick up skills added or changed on disk during this session', argumentHint: '' },
  { name: 'rename', description: 'Rename the current conversation', argumentHint: '[name]', aliases: ['name'] },
  { name: 'review', description: 'Review a GitHub pull request; for your working diff use /code-review', argumentHint: '[pr number]' },
  { name: 'run', description: 'Launch and drive this project\'s app to see a change working. Use when asked to run, start, or screenshot the app, or to confirm a change works in the real app…', argumentHint: '' },
  { name: 'run-skill-generator', description: 'Author or improve the run-<unit> skill — a per-project skill that tells agents how to build, launch, and drive this project\'s app. Use when the user asks to…', argumentHint: '' },
  { name: 'schedule', description: 'Create, update, list, or run scheduled cloud agents (routines) that execute on a cron schedule.', argumentHint: '', aliases: ['routines'] },
  { name: 'security-review', description: 'Complete a security review of the pending changes on the current branch', argumentHint: '' },
  { name: 'simplify', description: 'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use…', argumentHint: '[<target>]' },
  { name: 'team-onboarding', description: 'Help teammates ramp on Claude Code with a guide from your usage', argumentHint: '' },
  { name: 'ultrareview', description: 'Start a cloud agent that finds and verifies bugs in your branch (~5-10 min, $5-$25 USD) · Runs in Claude Code on the web. See…', argumentHint: '' },
  { name: 'update-config', description: 'Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when X", "each time X", "whenever X", "before/after…', argumentHint: '' },
  { name: 'usage', description: 'Show session cost, plan usage, and what\'s contributing to your limits', argumentHint: '', aliases: ['cost', 'stats'] },
  { name: 'usage-credits', description: 'Configure usage credits or request them from your admin when you hit a limit', argumentHint: '' },
  { name: 'verify', description: 'Verify that a code change actually does what it\'s supposed to by exercising it end-to-end and observing behavior — drive the affected flow, not just tests or…', argumentHint: '' },
];

// TUI-only commands the embedded terminal handles natively. Never shown for
// SDK threads (whatever supportedCommands() does not return does not exist
// there); the terminal receives composer text verbatim, so all of these work.
export const TERMINAL_EXTRA_COMMANDS: SlashCommandInfo[] = [
  { name: 'clear', description: 'Clear conversation history', argumentHint: '' },
  { name: 'help', description: 'Show help and available commands', argumentHint: '' },
  { name: 'workflows', description: 'Browse running and completed workflows', argumentHint: '' },
  { name: 'fork', description: 'Copy this conversation into a new background session and keep working here', argumentHint: '' },
  { name: 'cd', description: 'Move this session to a new working directory', argumentHint: '<path>' },
  { name: 'config', description: 'Open the settings panel', argumentHint: '' },
  { name: 'model', description: 'Set the AI model for this session', argumentHint: '' },
  { name: 'permissions', description: 'Manage tool permissions', argumentHint: '' },
  { name: 'status', description: 'Show session status (version, model, account)', argumentHint: '' },
  { name: 'cost', description: 'Show token usage and cost for this session', argumentHint: '' },
  { name: 'usage', description: 'Show plan usage limits', argumentHint: '' },
  { name: 'doctor', description: 'Diagnose the Claude Code installation', argumentHint: '' },
  { name: 'memory', description: 'Edit memory files (CLAUDE.md)', argumentHint: '' },
  { name: 'mcp', description: 'Manage MCP server connections', argumentHint: '' },
  { name: 'agents', description: 'Manage agent configurations', argumentHint: '' },
  { name: 'resume', description: 'Resume a previous conversation', argumentHint: '' },
  { name: 'rewind', description: 'Rewind the conversation and/or code changes', argumentHint: '' },
  { name: 'export', description: 'Export the conversation to a file or clipboard', argumentHint: '' },
  { name: 'add-dir', description: 'Add a working directory to the session', argumentHint: '<path>' },
  { name: 'hooks', description: 'Manage hook configurations', argumentHint: '' },
  { name: 'output-style', description: 'Set the output style for responses', argumentHint: '' },
  { name: 'statusline', description: 'Set up the status line UI', argumentHint: '' },
  { name: 'vim', description: 'Toggle vim editing mode', argumentHint: '' },
  { name: 'terminal-setup', description: 'Install Shift+Enter key binding', argumentHint: '' },
];

// Seed list shown before an Antigravity session reports its live available_commands_update
// and disk-discovered skills. Replaced once live data lands.
export const ANTIGRAVITY_BUILTIN_FALLBACK: SlashCommandInfo[] = [
  { name: 'compact', description: 'Summarize this conversation to free up context window', argumentHint: '' },
  { name: 'goal', description: 'Run a native Antigravity goal until the objective is achieved', argumentHint: '<objective>' },
  { name: 'plan', description: 'Plan the approach step-by-step before editing', argumentHint: '<task>' },
];

// Claude commands hidden on SDK threads because Orion overrides them with its
// own handler (/clear, /model) or has no equivalent surface yet (/resume,
// /rewind — session picking is Orion's thread list).
export const OVERRIDDEN_CLAUDE_COMMANDS = new Set(['clear', 'model', 'resume', 'rewind']);
export const OVERRIDDEN_ANTIGRAVITY_COMMANDS = new Set(['model', 'logout']);

/**
 * The slash menu is active only while the whole draft is a single
 * `/`-prefixed token — matching Claude Code, where a command must start the
 * prompt. Whitespace anywhere (including a trailing space after the completed
 * name) ends the token, so pasted prose and argument editing never reopen it.
 */
export const getSlashToken = (value: string): { query: string } | null => {
  const match = value.match(/^\/(\S*)$/);
  return match ? { query: match[1] } : null;
};

const commandNames = (command: SlashCommandInfo) => [command.name, ...(command.aliases ?? [])];

/**
 * Rank: name prefix > alias prefix > name substring > description substring.
 * Stable within a rank, so the builder's ordering (Orion first, then Claude
 * alphabetical) shows through for short queries.
 */
export const filterSlashCommands = (
  candidates: SlashCommandCandidate[],
  query: string
): SlashCommandCandidate[] => {
  const needle = query.toLowerCase();
  if (!needle) return candidates;
  const ranked: Array<{ candidate: SlashCommandCandidate; rank: number }> = [];
  for (const candidate of candidates) {
    const { command } = candidate;
    const name = command.name.toLowerCase();
    let rank: number | null = null;
    if (name.startsWith(needle)) rank = 0;
    else if ((command.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(needle))) rank = 1;
    else if (name.includes(needle)) rank = 2;
    else if (command.description.toLowerCase().includes(needle)) rank = 3;
    if (rank !== null) ranked.push({ candidate, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.candidate);
};

const byName = (a: SlashCommandInfo, b: SlashCommandInfo) => a.name.localeCompare(b.name);

/** Merge lists by name; earlier lists win. */
const mergeCommandLists = (...lists: SlashCommandInfo[][]): SlashCommandInfo[] => {
  const seen = new Map<string, SlashCommandInfo>();
  for (const list of lists) {
    for (const command of list) {
      if (!seen.has(command.name)) seen.set(command.name, command);
    }
  }
  return [...seen.values()];
};

export const buildSlashCommandCandidates = (
  context: SlashCommandContext,
  liveCommands: SlashCommandInfo[] | null
): SlashCommandCandidate[] => {
  if (context.isTerminal) {
    // The TUI handles everything natively, including TUI-only commands. Live
    // data (from a sibling SDK session in the same project) contributes custom
    // commands and richer descriptions where names overlap.
    const merged = mergeCommandLists(
      liveCommands ?? [],
      TERMINAL_EXTRA_COMMANDS,
      CLAUDE_BUILTIN_FALLBACK
    ).sort(byName);
    return merged.map((command) => ({ command, source: 'claude' as const }));
  }
  const orion: SlashCommandCandidate[] = ORION_SLASH_COMMANDS.filter((command) =>
    command.appliesTo(context)
  ).map(({ appliesTo: _appliesTo, ...command }) => ({ command, source: 'orion' as const }));
  const orionNames = new Set(orion.map((candidate) => candidate.command.name));
  if (context.providerId === 'antigravity') {
    const antigravity = mergeCommandLists(liveCommands ?? ANTIGRAVITY_BUILTIN_FALLBACK)
      .filter(
        (command) =>
          !OVERRIDDEN_ANTIGRAVITY_COMMANDS.has(command.name) && !orionNames.has(command.name)
      )
      .sort(byName)
      .map((command) => ({ command, source: 'antigravity' as const }));
    return [...orion, ...antigravity];
  }
  if (!context.claudeBacked) return orion;
  // mergeCommandLists dedupes by name — lists from older caches may predate
  // main-side normalization.
  const claude = mergeCommandLists(liveCommands ?? CLAUDE_BUILTIN_FALLBACK)
    .filter(
      (command) => !OVERRIDDEN_CLAUDE_COMMANDS.has(command.name) && !orionNames.has(command.name)
    )
    .sort(byName)
    .map((command) => ({ command, source: 'claude' as const }));
  return [...orion, ...claude];
};

/**
 * The command a completed draft refers to (`/name` followed by whitespace or
 * arguments, or an exact name when the menu is dismissed) — drives the
 * argument-hint strip under the composer.
 */
export const completedSlashCommand = (
  value: string,
  candidates: SlashCommandCandidate[]
): SlashCommandCandidate | null => {
  const match = value.match(/^\/(\S+)(?:\s|$)/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return (
    candidates.find((candidate) =>
      commandNames(candidate.command).some((candidateName) => candidateName.toLowerCase() === name)
    ) ?? null
  );
};
