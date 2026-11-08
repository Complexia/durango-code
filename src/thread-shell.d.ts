// Types for thread-shell.js (shared by the renderer store and main's storage).

type ShellMessage = {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  ts: string;
  kind?: 'text' | 'agent-run' | 'claude-background-intervention';
  status?: 'running' | 'done' | 'error' | 'stopped';
  statusText?: string;
  startedAt?: string;
  completedAt?: string;
  steer?: boolean;
  stats?: { totalTokens?: number };
};

/**
 * What a thread's shell knows about its transcript, so lists, headers and the
 * sidebar never need the messages. Changes only when a message is added or a
 * message's status/timing changes, never on streamed text or tool activity.
 */
export type ThreadSummary = {
  messageCount: number;
  lastMessage: {
    id: string;
    role: ShellMessage['role'];
    kind?: ShellMessage['kind'];
    ts: string;
    status?: ShellMessage['status'];
    completedAt?: string;
  } | null;
  /** The newest agent-run message. */
  lastAgentRun: {
    id: string;
    ts: string;
    status?: ShellMessage['status'];
    startedAt?: string;
    completedAt?: string;
    totalTokens?: number;
  } | null;
  /** Agent-run messages from the agent (durangoDispatch run offsets). */
  agentRunCount: number;
  hasUserMessage: boolean;
  /** Start (ms) of the newest stretch of agent work: the sidebar's "Working 12s". */
  workingSince: number | null;
  /** Total time of finished agent runs. */
  workedMs: number;
  /** Start times (ms) of agent runs still marked running. */
  runningRunStarts: number[];
};

export const WAITING_ON_BACKGROUND_CAPTION: RegExp;
export const STEERED_RUN_CAPTION: string;
export const TRANSCRIPT_KEYS: readonly ['messages', 'btwExchanges'];

export function workStartedAt<M extends ShellMessage>(messages: M[], message: M): number;
export function summarizeThreadMessages(messages: readonly ShellMessage[] | undefined): ThreadSummary;
export function sameThreadSummary(a: ThreadSummary | undefined, b: ThreadSummary | undefined): boolean;
export function threadShellOf<T extends object>(record: T): Omit<T, 'messages' | 'btwExchanges' | 'summary'>;
export function persistedShellOf<T extends object>(record: T): Omit<T, 'messages' | 'btwExchanges' | 'summary'>;
export function withSubagentDetails<T>(info: T, fuller: unknown): T;
export function mergeShellWithStored<T extends object>(shell: T, stored: unknown): T & { messages: unknown[] };

export function normalizeSearchText(value: string): string;
export const ACTIVITY_DETAIL_INDEX_LIMIT: number;
export function messageSearchText(message: unknown): string;
export function isWordStart(text: string, index: number): boolean;
export const BODY_MATCH_WORD: number;
export const BODY_MATCH_SUBSTRING: number;
export function scoreBodyToken(chunks: readonly string[], token: string): number;
export function transcriptExcerpt(
  messages: readonly { content?: string }[] | undefined,
  tokens: readonly string[],
  body?: readonly string[]
): string | null;
