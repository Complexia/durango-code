// Durango bots in Durango Code (Sidebar v3): the shapes the desktop reads from
// Durango (GET /api/v1/bots, /api/v1/bots/:id/messages) and small pure
// helpers. A bot is an always-on assistant with one thread; messages to it
// are never blocked, and its replies may run on this machine's Claude Code.

export type DesktopBot = {
  id: string;
  name: string;
  emoji: string | null;
  role: 'primary' | 'bot';
  job: string;
  model: string;
  status: 'idle' | 'waking' | 'running';
  paused: boolean;
  /** Replies being written right now, and where each runs ("cloud" or "machine:<id>"). */
  replies: { messageId: string; place: string }[];
  lastActivityAt: number;
  lastPreview: string | null;
  unread: number;
  needsYou: boolean;
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
  /** Signed in: the download link. */
  url: string | null;
};
export type BotProject = { projectKey: string; name: string | null; botId: string | null; notes: BotProjectNote[]; files: BotProjectFile[] };
export type BotProjectResult = { ok: boolean; project?: BotProject | null; error?: string };
/** Whose notes and files: a project bot's, or a project open here (it needs no bot). */
export type BotProjectTarget = { botId: string; projectId?: never } | { projectId: string; botId?: never };
export type EnsureProjectBotResult = { ok: boolean; bot?: DesktopBot; error?: string; code?: string };

export type DesktopBotMessage = {
  id: string;
  seq: number;
  role: string;
  content: string;
  /** Inbox source labels ("Routine: …", "Task: …", "Bot: …") or "via <machine>" on replies. */
  authorLabel: string | null;
  createdAt: number;
  /** Files sent with it. */
  files?: { name: string; size?: number }[];
};

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
};

export type DesktopBotThread = {
  bot: DesktopBot;
  messages: DesktopBotMessage[];
  live: DesktopBotLive[];
  hasMore: boolean;
};

export type BotsListResult = {
  ok: boolean;
  allowed?: boolean;
  bots?: DesktopBot[];
  /** Each Durango Code project's key (project id → key), to find its bot. */
  projectKeys?: Record<string, string>;
  /** Whose bots these are ("local", or a hash of the Durango account): cached data of another account is dropped. */
  account?: string;
  error?: string;
  code?: string;
};

/** The bot of a project (by the project's key), if it exists yet. */
export const projectBotFor = (bots: DesktopBot[], key: string | undefined) =>
  key ? bots.find((bot) => bot.project?.key === key) ?? null : null;

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
