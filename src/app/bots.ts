// Durango bots in Durango Code (Sidebar v3): the shapes the desktop reads from
// Durango (GET /api/v1/bots, /api/v1/bots/:id/messages) and small pure
// helpers. A bot is an always-on assistant with one thread; messages to it
// are never blocked, and its replies may run on this machine's Claude Code.

import { sortProjectBots } from './botOrder';

export type DesktopBot = {
  id: string;
  name: string;
  emoji: string | null;
  role: 'primary' | 'bot';
  /** True when this bot is its project's primary (overseer of that project's other bots). */
  projectPrimary?: boolean;
  /** Manual sidebar position within its project group (0, 1, 2…); null/absent = default order. */
  sortOrder?: number | null;
  job: string;
  model: string;
  /** Optional reasoning effort override ("none", "low", "medium", "high", "xhigh", "max"); null/absent = model default. */
  reasoningEffort?: string | null;
  /** The bot's current conversation id (rotates when cleared so cached threads reset). */
  threadId?: string;
  status: 'idle' | 'waking' | 'running';
  paused: boolean;
  /** Replies being written right now, and where each runs ("cloud" or "machine:<id>"). */
  replies: { messageId: string; place: string }[];
  lastActivityAt: number;
  lastPreview: string | null;
  unread: number;
  /** It asked the person something (ask_user), or a thread it started waits on them ("Needs you"). */
  needsYou: boolean;
  /** Just the ask_user part of `needsYou` (absent from older Durango servers). */
  asked?: boolean;
  /** What the threads it started wait on the person for (botThreadRequests.ts), oldest first. */
  requests?: import('./botThreadRequests').BotThreadRequest[];
  createdAt?: number;
  /** A project bot's project (Durango's key: the Source repo, or a machine's project). */
  project?: { key: string; name: string; repoId: string | null } | null;
};

export type BotProjectNote = { id: string; content: string; author: string; createdAt: number };
export type BotProjectFile = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  author: string;
  updatedAt: number;
  /** Library asset backing this file (absent for legacy Convex-storage files or signed-out local files). */
  assetId?: string | null;
  /** Signed in: the Durango Library link for viewing this file. */
  url: string | null;
};
export type BotProject = { projectKey: string; name: string | null; botId: string | null; notes: BotProjectNote[]; files: BotProjectFile[] };
export type BotProjectResult = { ok: boolean; project?: BotProject | null; error?: string };
/** Whose notes and files: a project bot's, or a project open here (it needs no bot). */
export type BotProjectTarget = { botId: string; projectId?: never } | { projectId: string; botId?: never };
export type EnsureProjectBotResult = { ok: boolean; bot?: DesktopBot; error?: string; code?: string };
export type CreateBotInput = {
  name: string;
  job?: string;
  emoji?: string;
  model?: string;
};
export type CreateProjectBotInput = {
  projectId?: string;
  project?: { key: string; name: string; repoId?: string | null };
  name?: string;
  job?: string;
  emoji?: string;
  model?: string;
};

export type DesktopBotRequestResolutionOp = 'done' | 'reply' | 'dismiss' | 'save' | 'decline' | 'answered' | 'resolved';
export type DesktopBotRequestResolutionBy = 'person' | 'bot' | 'agent';

export type DesktopBotRequestResolution = {
  op: DesktopBotRequestResolutionOp;
  by: DesktopBotRequestResolutionBy;
  byName?: string;
  machineName?: string;
  at: number;
};

export type DesktopBotMessage = {
  id: string;
  seq: number;
  role: string;
  content: string;
  /** Inbox source labels ("Routine: …", "Task: …", "Bot: …") or "via <machine>" on replies. */
  authorLabel: string | null;
  /** Set on an inbox item when the bot explicitly chose stay_silent (no reply posted). */
  silentRead?: { at: number; reason?: string } | null;
  /** Set on a "NEEDS THE PERSON" inbox notice once its thread request was resolved. */
  requestResolved?: DesktopBotRequestResolution | null;
  createdAt: number;
  /** Files sent with it (signed in: their library ids; signed out: their paths here). */
  files?: BotMessageFile[];
  /** A reply's cards: files it attached, HTML pages, buttons, questions (Durango Chat's ui parts). */
  cards?: BotCard[];
};

export type BotMessageFile = {
  name: string;
  size?: number;
  assetId?: string;
  contentType?: string;
  path?: string;
  /** Client-assigned id while uploading in the background (or failed/resolved). */
  pendingId?: string;
  status?: 'uploading' | 'ready' | 'failed';
  error?: string;
};

/** Live status of a local file uploading in the background for a bot message (main: bot-attachments.js). */
export type BotAttachmentUploadStatus = {
  botId: string;
  messageId: string;
  pendingId: string;
  name: string;
  size: number;
  contentType: string;
  kind?: string;
  localPath?: string;
  status: 'uploading' | 'ready' | 'failed';
  assetId?: string;
  error?: string;
  canRetry?: boolean;
};

/** A card under a bot reply, in Durango Chat's ui part shape (chat/andromedus/lib/chat-ui-parts.ts). */
export type BotCard = { id: string; component: string; props: unknown };

/** A read link (an hour) for a library file in a bot thread (GET /api/v1/bots/files). */
export type BotFileLink = { id: string; name: string; contentType: string; byteSize: number; url: string };

/** A button under a reply (show_actions; Durango's lib/bots/ui.ts botActionSchema). */
export type BotAction = {
  kind: 'ship_change' | 'open_change' | 'open_thread' | 'open_url' | 'reply';
  label?: string;
  change_id?: string;
  thread_id?: string;
  url?: string;
  text?: string;
};

const CHANGE_ID = /^chg_[a-z0-9]{8,40}$/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WEB_URL = /^https?:\/\/[^\s]+$/i;
const cut = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** One button from a stored card, checked again per kind (the card is data from the network), or null. */
export const parseBotAction = (raw: unknown): BotAction | null => {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = value.kind;
  const label = cut(value.label, 40) || undefined;
  const url = cut(value.url, 2000) || undefined;
  if (url && !WEB_URL.test(url)) return null;
  switch (kind) {
    case 'ship_change':
    case 'open_change': {
      const changeId = cut(value.change_id, 64);
      if (!CHANGE_ID.test(changeId)) return null;
      // Ship: the thread that made the change, which ships it (bots' Shipping rule).
      const threadId = kind === 'ship_change' ? cut(value.thread_id, 128) : '';
      return { kind, label, change_id: changeId, url, ...(THREAD_ID.test(threadId) ? { thread_id: threadId } : {}) };
    }
    case 'open_thread': {
      const threadId = cut(value.thread_id, 128);
      return THREAD_ID.test(threadId) ? { kind, label, thread_id: threadId } : null;
    }
    case 'open_url':
      return url && label ? { kind, label, url } : null;
    case 'reply':
      return label ? { kind, label, text: cut(value.text, 500) || undefined } : null;
    default:
      return null;
  }
};

export const botActionLabel = (action: BotAction) =>
  action.label ??
  (action.kind === 'ship_change' ? 'Ship' : action.kind === 'open_change' ? 'View change' : action.kind === 'open_thread' ? 'Open thread' : 'Open');

/**
 * The buttons a task report carries on its own: the thread it ran in and the
 * change its workspace holds (the "Thread: @thread:…" / "Change: chg_… (open) <url>"
 * lines Durango Code adds to the report), so the person can open or ship it
 * from the report itself.
 */
export const taskReportActions = (content: string): BotAction[] => {
  const actions: BotAction[] = [];
  // The refs line, else the thread footer (reports of threads Durango started have only that).
  const thread =
    /^Thread: @thread:([A-Za-z0-9_-]{1,128})\s*$/m.exec(content) ??
    /\(Durango Code thread ([A-Za-z0-9_-]{1,128})(?=[,.])[^\n]*[Ff]ollow up there[^\n]*\)/.exec(content);
  const change = /^Change: (chg_[a-z0-9]{8,40})(?: \((\w+)\))?(?: (https?:\/\/\S+))?\s*$/m.exec(content);
  if (change) {
    const status = change[2];
    const url = change[3];
    // Ship goes to the thread the report came from: it ships the change its project's way.
    if (!status || status === 'open') {
      actions.push({ kind: 'ship_change', change_id: change[1], ...(thread ? { thread_id: thread[1] } : {}), ...(url ? { url } : {}) });
    }
    actions.push({ kind: 'open_change', change_id: change[1], ...(url ? { url } : {}) });
  }
  if (thread) actions.push({ kind: 'open_thread', thread_id: thread[1] });
  return actions;
};

/**
 * What a Ship button sends the bot when the change's thread isn't on this
 * computer: the person's confirmed ship request, which the bot routes to that
 * thread (delegate_task thread_id). Durango's copy: lib/bots/ui.ts botShipRequestText.
 */
export const botShipRequestText = (action: Pick<BotAction, 'change_id' | 'thread_id'>) =>
  `Ship ${action.change_id ?? 'this change'} now (I confirmed): send it to the thread that made it${
    action.thread_id ? ` (Durango Code thread ${action.thread_id})` : ''
  } to ship the way its project ships, and tell me what it reports.`;

/** A file attached to a message being written: a path on this computer. */
export type BotAttachmentFile = {
  path: string;
  name: string;
  size: number;
  /** Images only: a data: or blob: URL for the thumbnail (never sent to the main process). */
  preview?: string;
};

export type DesktopBotLive = {
  messageId: string;
  place: string;
  content: string;
  activeTool: string | null;
  /** Its place in the thread, taken when it first shows text (null before): later messages go below it. */
  seq?: number | null;
  /** Its first sent message's place (a reply is several messages): polls read its messages again from there, as cards are added to them. */
  firstSeq?: number | null;
};

export type DesktopBotThread = {
  bot: DesktopBot;
  /** Recently resolved thread requests for this bot (brief confirmation above the composer). */
  resolvedRequests?: BotThreadRequest[];
  messages: DesktopBotMessage[];
  live: DesktopBotLive[];
  hasMore: boolean;
};

export type BotsListResult = {
  ok: boolean;
  allowed?: boolean;
  bots?: DesktopBot[];
  /** Manual order of project groups in the Bots sidebar (projectKeys, top to bottom). */
  projectOrder?: string[];
  /** Each Durango Code project's key (project id → key), to find its bot. */
  projectKeys?: Record<string, string>;
  /** Whose bots these are ("local", or a hash of the Durango account): cached data of another account is dropped. */
  account?: string;
  /** The recommended models a bot can be set to; null or absent (an older Durango): no picker. */
  modelChoices?: BotModelChoice[] | null;
  /** The full searchable catalog (recommended + cloud catalog + local Claude models). */
  modelCatalog?: BotModelChoice[] | null;
  error?: string;
  code?: string;
};

export type ReorderBotsInput = {
  /** New top-to-bottom order of project keys for the Bots sidebar. */
  projectOrder?: string[];
  /** Project key whose bots are being reordered (must be paired with `botIds`). */
  projectKey?: string;
  /** New top-to-bottom order of bot ids within `projectKey`. */
  botIds?: string[];
};
export type ReorderBotsResult = { ok: boolean; projectOrder?: string[]; error?: string; code?: string };

/** A model a bot can be set to. `claude` / `local`: it can reply on this machine's Claude Code (others reply from Durango's cloud). */
export type BotModelChoice = {
  id: string;
  label: string;
  note: string;
  claude: boolean;
  provider?: string;
  lab?: string;
  recommended?: boolean;
  legacy?: boolean;
  /** True when this model can run locally on one of this machine's harnesses (Claude Code, Codex, Antigravity, Grok, Muse). */
  local?: boolean;
  /** The harness that runs it here ("Claude Code", "Codex", "Antigravity", "Grok", "Muse"). */
  localVia?: string;
  efforts?: readonly string[];
  defaultEffort?: string;
};
export type SetBotModelResult = {
  ok: boolean;
  model?: string;
  reasoningEffort?: string | null;
  bot?: DesktopBot;
  error?: string;
  code?: string;
};
export type RenameBotResult = { ok: boolean; name?: string; bot?: DesktopBot; error?: string; code?: string };
export type UpdateBotInput = {
  botId: string;
  name?: string;
  job?: string;
  /** `null` clears the bot's emoji back to its automatic icon. */
  emoji?: string | null;
};
export type UpdateBotResult = { ok: boolean; name?: string; bot?: DesktopBot; error?: string; code?: string };
export type SetBotProjectPrimaryResult = { ok: boolean; bot?: DesktopBot; error?: string; code?: string };
export type DeleteBotResult = { ok: boolean; error?: string; code?: string };
export type ClearBotResult = { ok: boolean; bot?: DesktopBot; error?: string; code?: string };

const BOT_EFFORT_ORDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const DEFAULT_BOT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A bot's model as a short name: its choice's label, else the id's last part ("anthropic/claude-opus-5.5" → "claude-opus-5.5"). */
export const botModelLabel = (model: string, choices: readonly BotModelChoice[] | null | undefined) =>
  choices?.find((choice) => choice.id === model)?.label ?? model.split('/').pop() ?? model;

/** Supported reasoning efforts for a bot model. */
export const botModelEfforts = (model: string, choices: readonly BotModelChoice[] | null | undefined): readonly string[] => {
  const choice = choices?.find((item) => item.id === model);
  if (choice && Array.isArray(choice.efforts)) return choice.efforts;
  if (/gemini-4-neon/i.test(model)) return ['low', 'medium', 'high', 'xhigh'];
  if (/gemini/i.test(model)) return ['low', 'medium', 'high'];
  if (/gpt-6-luna/i.test(model)) return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  return DEFAULT_BOT_EFFORTS;
};

/** Default reasoning effort for a bot model when none is explicitly set. */
export const defaultBotReasoningEffort = (model: string, choices: readonly BotModelChoice[] | null | undefined): string => {
  const choice = choices?.find((item) => item.id === model);
  if (choice && Array.isArray(choice.efforts) && choice.efforts.length === 0) return '';
  if (choice?.defaultEffort) return choice.defaultEffort;
  if (/haiku/i.test(model)) return 'medium';
  if (choice?.claude || /claude/i.test(model)) return 'high';
  return 'medium';
};

/** Effective reasoning effort a bot runs on for `model`, clamping unsupported tiers. */
export const effectiveBotReasoningEffort = (
  model: string,
  effort: string | null | undefined,
  choices: readonly BotModelChoice[] | null | undefined
): string => {
  const supported = botModelEfforts(model, choices);
  if (supported.length === 0) return '';
  const clean = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  if (!clean) return defaultBotReasoningEffort(model, choices);
  if (supported.includes(clean)) return clean;
  const rank = BOT_EFFORT_ORDER.indexOf(clean as (typeof BOT_EFFORT_ORDER)[number]);
  if (rank >= 0) {
    for (let index = rank - 1; index >= 0; index -= 1) {
      const candidate = BOT_EFFORT_ORDER[index];
      if (supported.includes(candidate)) return candidate;
    }
    return supported[0] ?? defaultBotReasoningEffort(model, choices);
  }
  return defaultBotReasoningEffort(model, choices);
};

export const botReasoningEffortLabel = (effort: string | null | undefined): string => {
  switch ((effort ?? '').trim().toLowerCase()) {
    case 'none':
      return 'Off';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra high';
    case 'max':
      return 'Max';
    default:
      return '';
  }
};

export const botReasoningEffortShortLabel = (effort: string | null | undefined): string => {
  switch ((effort ?? '').trim().toLowerCase()) {
    case 'none':
      return 'Off';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Med';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'XHigh';
    case 'max':
      return 'Max';
    default:
      return '';
  }
};

/** Sort comparator for bots within a project when no manual order is set: project primary first, then most recently active. */
export const compareProjectBots = (a: DesktopBot, b: DesktopBot): number =>
  Number(Boolean(b.projectPrimary)) - Number(Boolean(a.projectPrimary)) || b.lastActivityAt - a.lastActivityAt;

/** All bots of a project (by the project's key), following manual order when set else primary first then most recently active. */
export const projectBotsFor = (bots: DesktopBot[], key: string | undefined): DesktopBot[] =>
  key ? sortProjectBots(bots.filter((bot) => bot.project?.key === key)) : [];

/** A project's primary/most-recent bot (by the project's key), if any exists yet. */
export const projectBotFor = (bots: DesktopBot[], key: string | undefined) =>
  projectBotsFor(bots, key)[0] ?? null;

export type ThreadStarterInput = {
  startedByBot?: string;
  startedByBotId?: string;
  durangoDispatch?: { id?: string; runOffset?: number; followUp?: boolean } | null;
};

export type ThreadStarter =
  | { kind: 'bot'; bot: DesktopBot | null; name: string }
  | { kind: 'durango' }
  | { kind: 'you' };

const localBotIdFromDispatchId = (dispatchId: string): string | null => {
  if (!dispatchId.startsWith('localbot:')) return null;
  const rest = dispatchId.slice('localbot:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const id = rest.slice(0, sep).trim();
  return id || null;
};

/**
 * Who started a Durango Code thread: the specific bot that dispatched it (local,
 * machine-run, or cloud-dispatched), Durango (Chat, Tasks, or API), or the
 * person. Never falls back to a project's primary bot when the starter isn't
 * found — returns the recorded bot name (or "A bot") instead.
 */
export const resolveThreadStarter = (
  thread: ThreadStarterInput,
  allBots: readonly DesktopBot[],
  projectBots: readonly DesktopBot[] = []
): ThreadStarter => {
  const recordedId = thread.startedByBotId?.trim() || null;
  const recordedName = thread.startedByBot?.trim() || null;
  const dispatchId = thread.durangoDispatch?.id ?? '';
  const isFollowUpOnly = Boolean(thread.durangoDispatch?.followUp || thread.durangoDispatch?.runOffset);
  const isBotDispatchId = dispatchId.startsWith('bottask:') || dispatchId.startsWith('localbot:');

  if (recordedId || recordedName || (isBotDispatchId && !isFollowUpOnly)) {
    const botId = recordedId ?? (isBotDispatchId && !isFollowUpOnly ? localBotIdFromDispatchId(dispatchId) : null);
    let matched: DesktopBot | null = null;
    if (botId) {
      matched =
        allBots.find((candidate) => candidate.id === botId) ??
        projectBots.find((candidate) => candidate.id === botId) ??
        null;
    } else if (recordedName && recordedName !== 'bot') {
      const lower = recordedName.toLowerCase();
      matched =
        projectBots.find((candidate) => candidate.name === recordedName) ??
        allBots.find((candidate) => candidate.name === recordedName) ??
        projectBots.find((candidate) => candidate.name.toLowerCase() === lower) ??
        allBots.find((candidate) => candidate.name.toLowerCase() === lower) ??
        null;
    }
    const name = matched?.name ?? (recordedName && recordedName !== 'bot' ? recordedName : 'A bot');
    return { kind: 'bot', bot: matched, name };
  }

  if (dispatchId && !isFollowUpOnly) return { kind: 'durango' };
  return { kind: 'you' };
};

export const formatFileSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** Signed out ("local"): bots live on this device and reply through its Claude Code. */
export type BotsModeResult = {
  mode: 'local' | 'durango';
  claudeAvailable: boolean;
  /** Signed in: this machine answers bots (Settings → Durango, "Answer your bots on this computer"). */
  machineReplies?: boolean;
};

/** The place of a reply running on this device for a local bot. */
export const LOCAL_BOT_PLACE = 'machine:local';

export type BotThreadResult = { ok: boolean; error?: string; code?: string } & Partial<DesktopBotThread>;

/** Where an inbox message came from, by its label (the person's own messages have none). */
export const botInboxSource = (authorLabel: string | null | undefined): 'person' | 'routine' | 'task' | 'bot' => {
  if (!authorLabel) return 'person';
  if (authorLabel.startsWith('Routine: ')) return 'routine';
  if (authorLabel.startsWith('Task: ')) return 'task';
  if (authorLabel.startsWith('Bot: ')) return 'bot';
  return 'person';
};

export const newBotMessageId = () =>
  `bm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export const botIsWorking = (bot: Pick<DesktopBot, 'status' | 'replies' | 'paused'>) =>
  !bot.paused && (bot.status !== 'idle' || bot.replies.length > 0);

export const relativeBotTime = (ms: number, now = Date.now()) => {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/**
 * A task report's own words, without what Durango Code adds for the bot (shown
 * as buttons instead): the refs block ("---" then Thread / Change / Workspace
 * lines) and the thread footer ("(Durango Code thread <id>, … Follow up there …)",
 * bot-thread-tools.js threadReportFooter), in either order.
 */
const REPORT_REFS = /\n+---\n(?:(?:Thread|Change|Workspace): [^\n]*(?:\n|$))+\s*$/;
const REPORT_FOOTER = /\n*\(Durango Code thread [A-Za-z0-9_-]{1,128}(?=[,.])[^\n]*[Ff]ollow up there[^\n]*\)\s*$/;
export const taskReportBody = (content: string) => {
  let body = content;
  for (let pass = 0; pass < 2; pass += 1) body = body.replace(REPORT_FOOTER, '').replace(REPORT_REFS, '');
  return body.trimEnd();
};

/** Human-facing status line for a resolved thread request card / inbox notice (mirrors convex/botPolicy.ts). */
export const requestResolutionLabel = (resolved: Pick<DesktopBotRequestResolution, 'op'>): string => {
  switch (resolved.op) {
    case 'done':
      return 'Done · thread continuing';
    case 'reply':
      return 'Replied · thread continuing';
    case 'save':
      return 'Secret saved · thread continuing';
    case 'decline':
      return 'Declined · thread continuing';
    case 'answered':
      return 'Answered · thread continuing';
    case 'dismiss':
      return 'Dismissed';
    case 'resolved':
      return 'Resolved · thread continuing';
  }
};

/** Who resolved a thread request, shown next to the status label (mirrors convex/botPolicy.ts). */
export const requestResolutionActor = (resolved: Pick<DesktopBotRequestResolution, 'op' | 'by' | 'byName'>): string => {
  if (resolved.by === 'person') return 'You';
  if (resolved.by === 'bot') return resolved.byName?.trim() || 'Bot';
  return resolved.op === 'done' ? 'Auto-detected' : 'Thread';
};

const NEEDS_PERSON_PREFIX = 'NEEDS THE PERSON:';
const NOTICE_REQUEST_HINT = /\n*\((?:Secret request|Request) [A-Za-z0-9:_.-]{1,128}:[^\n]*\)\s*$/i;
const NOTICE_THREAD_FOOTER = /\n*\(Durango Code thread [A-Za-z0-9_-]{1,128}(?=[,.])[^\n]*\)\s*$/;

/** Extracts the human-facing ask from a `NEEDS THE PERSON:` inbox notice; null for other messages. */
export const parseNeedsPersonNotice = (content: string): { summary: string; detail: string } | null => {
  if (!content.startsWith(NEEDS_PERSON_PREFIX)) return null;
  const split = content.indexOf('\n\n');
  let detail = split >= 0 ? content.slice(split + 2).trim() : content.slice(NEEDS_PERSON_PREFIX.length).trim();
  for (let pass = 0; pass < 2; pass += 1) {
    detail = detail.replace(NOTICE_THREAD_FOOTER, '').replace(NOTICE_REQUEST_HINT, '').trim();
  }
  const summary = detail
    .replace(/^It asked the person to:\s*/i, '')
    .replace(/^It asked the person:\s*/i, '')
    .trim();
  return { summary: summary || detail || 'Waiting on you', detail: detail || content };
};

/** Extracts the request ref from a `NEEDS THE PERSON` notice message id (`task_…_n_action:ua_…`, `btt_…_n_input:…`, `notice_…_action:ua_…`). */
export const noticeRequestIdFromMessageId = (messageId: string): { kind: 'action' | 'input'; id: string } | null => {
  const marker = messageId.indexOf('_n_');
  let key = marker >= 0 ? messageId.slice(marker + 3).trim() : '';
  if (!key && messageId.startsWith('notice_')) {
    const match = /_(action:[^\s]+|input:[^\s]+)$/.exec(messageId);
    if (match) key = match[1];
  }
  if (!key) return null;
  if (key.startsWith('action:')) return { kind: 'action', id: key.slice('action:'.length) };
  if (key.startsWith('input:')) return { kind: 'input', id: key.slice('input:'.length) };
  return null;
};
