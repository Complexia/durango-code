import { type FileAttachment, type LinkedBoardTask, type OrchestrationRoleId, type Thread } from '../store';
import { type AgentModel } from '../agentCatalog';
import { getThreadActivityTime } from './time';

export const linkedTaskFromBoardTask = (task: OrionBoardTask): LinkedBoardTask => ({
  id: task.id,
  title: task.title,
  description: task.description,
  attachments: (task.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    name: attachment.fileName,
    mimeType: attachment.contentType,
    size: attachment.size,
    path: attachment.localPath,
    downloadError: attachment.downloadError,
  })),
  injected: false,
});

export const linkedTaskAttachments = (tasks: LinkedBoardTask[]): FileAttachment[] =>
  tasks.flatMap((task) =>
    (task.attachments ?? [])
      .filter((attachment) => Boolean(attachment.path))
      .map((attachment) => ({
        id: `board-${task.id}-${attachment.id}`,
        name: attachment.name,
        path: attachment.path!,
        mimeType: attachment.mimeType,
        size: attachment.size,
      }))
  );

const linkedTaskBody = (task: LinkedBoardTask, lines: string[]) => {
  const description = task.description.trim();
  if (description) {
    lines.push('', 'Description:', description);
  }
  const taskAttachments = task.attachments ?? [];
  if (taskAttachments.length > 0) {
    lines.push('', 'Attachments:');
    taskAttachments.forEach((attachment, index) => {
      if (attachment.path) {
        lines.push(`${index + 1}. ${attachment.name} (${attachment.mimeType}): ${attachment.path}`);
      } else {
        lines.push(
          `${index + 1}. ${attachment.name} (${attachment.mimeType}): unavailable locally${
            attachment.downloadError ? ` — ${attachment.downloadError}` : ''
          }`
        );
      }
    });
  }
};

// Context block prepended to the first agent turn carrying a thread's linked
// Durango Tasks (formerly the Durango Code board), so the agent knows what cards it's working on and can read
// local copies of every board attachment. A thread may link any number of
// cards; they are all presented together as one body of work.
export const buildLinkedTaskContext = (tasks: LinkedBoardTask[], hasUserMessage: boolean) => {
  if (tasks.length === 0) return '';
  const multiple = tasks.length > 1;
  const noun = multiple ? 'tasks' : 'task';
  const pronoun = multiple ? 'them' : 'it';
  const lines = multiple
    ? [`## Linked tasks from Durango Tasks`, `${tasks.length} tasks are linked to this thread.`]
    : ['## Linked task from Durango Tasks', `Title: ${tasks[0].title}`];
  if (multiple) {
    tasks.forEach((task, index) => {
      lines.push('', `### Task ${index + 1}: ${task.title}`);
      linkedTaskBody(task, lines);
    });
  } else {
    linkedTaskBody(tasks[0], lines);
  }
  if (tasks.some((task) => (task.attachments ?? []).length > 0)) {
    lines.push('', 'Treat these attachments as part of the task context and inspect them as needed.');
  }
  if (hasUserMessage) {
    lines.push(
      '',
      `This thread is linked to the ${noun} above; treat ${pronoun} as the goal of the work. The user message follows.`,
      '',
      '---'
    );
  } else {
    lines.push(
      '',
      `This thread is linked to the ${noun} above; treat ${pronoun} as the goal of the work and carry ${pronoun} out.`
    );
  }
  return lines.join('\n');
};

// Codex's dedicated reviewer is displayed inline on the resumed thread, but
// the reviewer model itself does not inherit prior turns. Carry Orion's recent
// transcript explicitly so references such as "the issues you found" resolve
// the same way they do in the surrounding chat.
export const REVIEW_THREAD_CONTEXT_MAX_CHARS = 80_000;
export const buildReviewThreadContext = (thread: Thread) => {
  const entries = thread.messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'agent') && message.content.trim().length > 0
    )
    .map((message) => {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      const attachments = (message.attachments ?? [])
        .map((attachment) => `${attachment.name}: ${attachment.path}`)
        .join('\n');
      return `${role}:\n${message.content.trim()}${
        attachments ? `\n\nAttachments:\n${attachments}` : ''
      }`;
    });

  const selected: string[] = [];
  let selectedChars = 0;
  let truncated = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const separatorChars = selected.length > 0 ? 6 : 0;
    if (selectedChars + separatorChars + entry.length > REVIEW_THREAD_CONTEXT_MAX_CHARS) {
      truncated = true;
      if (selected.length === 0) {
        selected.push(entry.slice(-REVIEW_THREAD_CONTEXT_MAX_CHARS));
      }
      break;
    }
    selected.unshift(entry);
    selectedChars += separatorChars + entry.length;
  }

  const sections: string[] = [];
  if (thread.linkedTasks?.length) sections.push(buildLinkedTaskContext(thread.linkedTasks, false));
  if (selected.length > 0) {
    sections.push(
      [
        '[Orion thread context]',
        'These messages preceded the review. Use them to resolve references and understand the intent behind the changes.',
        ...(truncated ? ['Earlier messages were omitted to fit the review context limit.'] : []),
        '',
        selected.join('\n\n---\n\n'),
        '[/Orion thread context]',
      ].join('\n')
    );
  }
  return sections.join('\n\n');
};

// Human labels for the Orion orchestrator's delegation roles — shared by the
// Settings → Orchestration tab and the orchestration payload/prompt so the
// names the user configures are the names the orchestrator sees.
export const orchestrationRoleMeta: Array<{
  id: OrchestrationRoleId;
  label: string;
  desc: string;
  /** How the role is named inside the [Orion orchestration] prompt block. */
  promptLabel: string;
}> = [
  {
    id: 'mainDriver',
    label: 'Main driver',
    desc: 'Coordinates the work, talks to you, and delegates to the other models',
    promptLabel: 'main driver',
  },
  {
    id: 'computerUse',
    label: 'Computer use',
    desc: 'Desktop control and GUI automation tasks',
    promptLabel: 'computer use',
  },
  {
    id: 'exploring',
    label: 'Exploring',
    desc: 'Codebase exploration, research, and read-only investigation',
    promptLabel: 'exploring',
  },
  {
    id: 'implementation',
    label: 'Implementation',
    desc: 'Code changes and implementation work',
    promptLabel: 'implementation',
  },
  {
    id: 'imageVideoGen',
    label: 'Image / video generation',
    desc: 'Generating images, video, and other media assets',
    promptLabel: 'image/video generation',
  },
];

export const accessModeOptions: Array<{
  value: 'read-only' | 'workspace-write' | 'full-access';
  label: string;
}> = [
  { value: 'read-only', label: 'Read only' },
  { value: 'workspace-write', label: 'Workspace write' },
  { value: 'full-access', label: 'Full access' },
];

// Context block prepended to every orchestrated turn. main.js writes managed
// CLAUDE.md/AGENTS.md sections that tell the agent orchestration applies when
// the prompt contains exactly this [Orion orchestration] marker.
export const buildOrchestrationContext = (
  roles: Array<{ role: string; modelLabel: string; slug: string }>,
  generalInstructions: string,
  accessMode: 'read-only' | 'workspace-write' | 'full-access'
) => {
  const roleSummary = orchestrationRoleMeta
    .filter((meta) => meta.id !== 'mainDriver')
    .map((meta) => {
      const entry = roles.find((role) => role.role === meta.id);
      return entry ? `${meta.promptLabel} → ${entry.modelLabel} (${entry.slug})` : null;
    })
    .filter(Boolean)
    .join('; ');
  const lines = [
    '[Orion orchestration]',
    'You are the Durango Code orchestrator (main driver). Delegate specialized work to the configured role models and integrate their results; see the "Durango Code Orchestration" section of CLAUDE.md / AGENTS.md for delegation mechanics.',
    `Roles: ${roleSummary}.`,
    'Prefer the spawn_subagent tool when available; otherwise run the provider CLIs directly. Report progress and the integrated final result yourself.',
  ];
  if (accessMode === 'read-only') {
    lines.push(
      'Access mode: Read only. Every delegated CLI must remain read-only: codex uses `--sandbox read-only`; claude uses `--permission-mode plan`; cursor uses `--mode plan --sandbox enabled`; grok uses `--permission-mode plan`. Never use bypass, force, auto-approve, or browser-control flags. Kimi may only be delegated through the `spawn_subagent` tool, whose child inherits this access mode; never invoke kimi prompt mode directly because it auto-approves every tool and cannot be made read-only.'
    );
  } else if (accessMode === 'workspace-write') {
    lines.push(
      'Access mode: Workspace write. Delegated CLIs must remain sandboxed to the workspace: codex uses `--sandbox workspace-write`; claude uses `--permission-mode acceptEdits`; cursor uses `--sandbox enabled --force`; grok uses `--permission-mode acceptEdits`. Do not disable a sandbox or use unrestricted bypass flags. Kimi may only be delegated through the `spawn_subagent` tool, whose child inherits this access mode; never invoke kimi prompt mode directly because it auto-approves every tool and cannot be sandboxed.'
    );
  } else {
    lines.push(
      'Access mode: Full access. Delegated CLIs may use their explicit bypass/full-access flags.'
    );
  }
  const trimmedInstructions = generalInstructions.trim();
  if (trimmedInstructions) lines.push(trimmedInstructions);
  lines.push('[/Orion orchestration]');
  return lines.join('\n');
};

// Context block prepended to every agent turn started from Orion, whatever
// model the thread runs on — the user's general instructions act like a
// global CLAUDE.md/AGENTS.md scoped to Orion, without touching on-disk files
// that the same CLIs would read when launched outside Orion. Orchestrated
// turns skip this block: the [Orion orchestration] block already carries the
// same instructions.
export const buildGeneralInstructionsContext = (generalInstructions: string) => {
  const trimmed = generalInstructions.trim();
  if (!trimmed) return '';
  return [
    '[Orion general instructions]',
    'The user configured these standing instructions in Durango Code. They apply to every agent session run through Durango Code, alongside any project instructions:',
    trimmed,
    '[/Orion general instructions]',
  ].join('\n');
};

export type ModelMention = {
  modelId: string;
  providerId: string;
  slug: string;
  label: string;
  token: string;
};

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Slugs are normally the friendliest mention token. When two providers expose
// the same slug, qualify it with the provider id so selecting one model cannot
// silently mention both (for example Claude and Cursor's claude-opus-4-8).
export const modelMentionToken = (model: AgentModel, models: AgentModel[]) =>
  models.some(
    (candidate) =>
      candidate.id !== model.id && candidate.slug.toLowerCase() === model.slug.toLowerCase()
  )
    ? model.id
    : model.slug;

// Scan the user's original text for model mention tokens against the catalog.
// The token must not continue into a longer slug/id-like value (so
// "@gpt-5.4-mini" never also matches "@gpt-5.4").
export const parseModelMentions = (text: string, models: AgentModel[]): ModelMention[] => {
  if (!text.includes('@')) return [];
  const mentions: ModelMention[] = [];
  for (const model of models) {
    // The Orion orchestrator is not a delegation target — "@orion" is never a mention.
    if (model.providerId === 'orion') continue;
    const token = modelMentionToken(model, models);
    const pattern = new RegExp(
      `(?:^|\\s)@${escapeRegExp(token)}(?![A-Za-z0-9._:/-])`,
      'i'
    );
    if (pattern.test(text)) {
      mentions.push({
        modelId: model.id,
        providerId: model.providerId,
        slug: model.slug,
        label: model.label,
        token,
      });
    }
  }
  return mentions;
};

// Context block prepended when the user @-mentions models, on any thread —
// mentions work when talking to a specific model too, not just Orion.
export const buildModelMentionsContext = (mentions: ModelMention[]) =>
  [
    '[Model mentions]',
    'The user referenced these models with @-mentions. When asked to use a mentioned model, delegate that work to it with the `spawn_subagent` tool from Durango Code\'s `orion` MCP server (the fully-qualified name varies by provider, for example mcp__orion__spawn_subagent, orion.spawn_subagent, or a plugin-prefixed equivalent), passing model: "<modelId>" and a self-contained prompt. The task runs as a visible Durango Code subthread and the call returns its final report — integrate that into your work. Do NOT hunt for or invoke that model\'s CLI yourself unless no `spawn_subagent` tool is genuinely present in your tool list.',
    ...mentions.map((mention) => `- @${mention.token} → ${mention.label} (${mention.modelId})`),
    '[/Model mentions]',
  ].join('\n');

export type ThreadMention = {
  thread: Thread;
  token: string;
};

// The 8-character id fragment that anchors an @thread mention token. Titles
// change (they are even LLM-refined asynchronously), so the fragment — not the
// title slug — is what a mention resolves by.
export const threadMentionIdFragment = (threadId: string) =>
  threadId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);

export const threadMentionToken = (thread: Thread) => {
  const slug = thread.title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `thread:${slug ? `${slug}-` : ''}${threadMentionIdFragment(thread.id)}`;
};

// Scan the user's original text for @thread mention tokens. Matching keys off
// the trailing id fragment so a mention still resolves if the thread was
// retitled between typing and sending.
export const parseThreadMentions = (
  text: string,
  threads: Thread[],
  excludeThreadId?: string
): ThreadMention[] => {
  if (!/@thread:/i.test(text)) return [];
  const mentions: ThreadMention[] = [];
  for (const thread of threads) {
    if (thread.id === excludeThreadId) continue;
    const fragment = threadMentionIdFragment(thread.id);
    if (!fragment) continue;
    const pattern = new RegExp(
      `(?:^|\\s)@thread:[A-Za-z0-9-]*${escapeRegExp(fragment)}(?![A-Za-z0-9._:/-])`,
      'i'
    );
    if (pattern.test(text)) {
      mentions.push({ thread, token: threadMentionToken(thread) });
    }
  }
  return mentions;
};

// `@thread:<ref>` references in chat text, where <ref> is a full thread id or
// an @thread mention token. Group 1 is the ref without the `@thread:` prefix.
export const threadReferencePattern = /(?<![A-Za-z0-9._/-])@thread:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/g;

// Resolve a thread reference written in chat — by users or agents — to a known
// thread: exact id first, then the id fragment that ends a mention token (or
// stands alone). An ambiguous fragment resolves to nothing rather than a guess.
export const resolveThreadReference = (reference: string, threads: Thread[]) => {
  const ref = reference.toLowerCase();
  const exact = threads.find((thread) => thread.id.toLowerCase() === ref);
  if (exact) return exact;
  const matches = threads.filter((thread) => {
    const fragment = threadMentionIdFragment(thread.id);
    return fragment.length === 8 && (ref === fragment || ref.endsWith(`-${fragment}`));
  });
  return matches.length === 1 ? matches[0] : undefined;
};

// Context block prepended when the user @-mentions other Orion threads. It
// deliberately carries only metadata — the agent pulls transcript pages on
// demand through the read_thread MCP tool instead of having whole threads
// stuffed into its prompt.
export const buildThreadMentionsContext = (
  mentions: ThreadMention[],
  projectNameById?: Map<string, string>
) =>
  [
    '[Thread mentions]',
    'The user referenced these Durango Code threads (separate agent conversations in this app) with @-mentions. Their transcripts are NOT included here. To see what happened in a mentioned thread, call the `read_thread` tool from Durango Code\'s `orion` MCP server (the fully-qualified name varies by provider, for example mcp__orion__read_thread, orion.read_thread, or a plugin-prefixed equivalent) with its thread_id. It returns thread metadata plus a page of messages — the newest page by default; browse earlier ones with offset/limit. Read a mentioned thread before making claims about what happened in it, and pull only the pages the task needs. To point the user at a thread in your reply, write `@thread:<thread_id>`; Durango Code renders it as a clickable link that opens the thread.',
    ...mentions.map(({ thread, token }) => {
      const projectName = projectNameById?.get(thread.projectId);
      const details = [
        `thread_id: ${thread.id}`,
        `${thread.messages.length} messages`,
        `status: ${thread.status}`,
        ...(projectName ? [`project: ${projectName}`] : []),
        `last active: ${getThreadActivityTime(thread).toISOString()}`,
      ].join('; ');
      return `- @${token} → "${thread.title}" (${details})`;
    }),
    '[/Thread mentions]',
  ].join('\n');

export const linkedTaskStatusLabel = (status?: string) => {
  switch (status) {
    case 'running':
      return 'In progress';
    case 'finished':
      return 'In review';
    case 'done':
      return 'Done';
    case 'error':
      return 'Error';
    default:
      return 'Linked';
  }
};
