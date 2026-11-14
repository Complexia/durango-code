import {
  addRemoteEventListener,
  canControlRemoteMachines,
  execOnRemoteMachine,
  fetchRemoteModels,
  fetchRemoteSnapshot,
  fetchRemoteThread,
  getRemoteControlState,
  runRemoteTurn,
  stopRemoteTurn,
} from './remote-control.js';
import { formatThreadForAgent } from './thread-reader.js';
import { ORION_MACHINE_READ_TOOL_NAMES, ORION_MACHINE_TOOL_NAMES } from './thread-reader-routing.js';

// The user's other machines, for agents: tools on Durango Code's built-in
// `orion` MCP server that reach every machine this one controls through
// remote control (Settings → Remote Control, "Machines you can control").
// They ride the same end-to-end encrypted sessions as the machine picker and
// the sidebar's threads of other machines (remote-control.js), so a thread
// can run commands and agents on any paired machine, whichever machine the
// thread itself runs on.
//
//   machine_list         the paired machines, whether they are reachable, their projects
//   machine_threads      a machine's threads (recent first)
//   machine_read_thread  one of its transcripts
//   machine_exec         a shell command there (`exec`, remote-exec.js)
//   machine_run_agent    an agent turn there: a new thread, or a follow-up in one
//   machine_stop_agent   stop a turn running there
//
// Offered while remote control is on and a machine is paired
// (canControlRemoteMachines); every call re-checks. Claude registers them on
// the in-process SDK server (claude-driver.js); every other provider gets
// them from the bridge's `__tools` list (mcp-bridge.js), so the schemas live
// only here.
//
// Access mode: the agent never gets more there than it has here. Read only
// lists and reads (machine_exec and the agent tools refuse); a turn it starts
// runs with at most its own access mode. Read tools are pre-approved in every
// mode, the others only in Full access (thread-reader-routing.js), so in
// Workspace write Claude asks the user before each command or turn. The other
// providers can't be relied on to ask (Codex approves every `orion` tool), so
// through the bridge the action tools need Full access
// (`requireFullAccess`, and they aren't listed below it).
//
// Handlers resolve to `{ ok, text }` and never throw.

export const MACHINE_TOOL_NAMES = ORION_MACHINE_TOOL_NAMES;

const ACCESS_MODES = ['read-only', 'workspace-write', 'full-access'];
const NO_PROJECT_ID = 'orion:no-project';
const SNAPSHOT_TIMEOUT_MS = 15_000;
const MAX_THREADS_LISTED = 100;
const MAX_REPLY_CHARS = 24_000;
const MAX_OUTPUT_CHARS = 30_000;
// A remote turn's end comes as a pushed event; this poll covers a missed one
// (a reconnect in between).
const WAIT_POLL_MS = 30_000;
const WAIT_MAX_FAILED_POLLS = 10;

// Injected by main.js: the engine's startup promise and the caller's project
// resolution (main.js `resolveRemoteProject`, which may clone a Durango
// Source repository there). Swappable in tests.
let deps = {
  ready: Promise.resolve(),
  resolveCallerProject: async () => ({ ok: false, error: 'Unavailable.' }),
  remote: {
    addRemoteEventListener,
    canControlRemoteMachines,
    execOnRemoteMachine,
    fetchRemoteModels,
    fetchRemoteSnapshot,
    fetchRemoteThread,
    getRemoteControlState,
    runRemoteTurn,
    stopRemoteTurn,
  },
};
const realRemote = deps.remote;

export const configureMachineTools = ({ ready, resolveCallerProject } = {}) => {
  if (ready) deps.ready = ready;
  if (resolveCallerProject) deps.resolveCallerProject = resolveCallerProject;
};

export const setMachineToolDepsForTests = (overrides = {}) => {
  deps = { ...deps, ...overrides, remote: { ...realRemote, ...(overrides.remote ?? {}) } };
};

/** Whether runs starting now get the machine tools. */
export const machineToolsAvailable = () => {
  try {
    return deps.remote.canControlRemoteMachines();
  } catch {
    return false;
  }
};

const machineProp = {
  type: 'string',
  description: 'The machine: its name or id from machine_list (may be left out when only one machine is paired)',
};

export const MACHINE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'machine_list',
    readOnly: true,
    description:
      "List the user's other computers this Durango Code can reach (machines paired in Settings → Remote Control): name, id, whether each is connected, and the projects on it. Use the machine_* tools to work on them: run shell commands (machine_exec), start or continue agent threads there (machine_run_agent), and read their threads. Call it first when the user mentions another machine by name (\"on omarchy\", \"my Linux box\") or when work has to happen where a file, service or device lives. These tools work whether or not this thread itself runs on another machine.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'machine_threads',
    readOnly: true,
    description:
      "List the Durango Code threads on another machine, most recently active first: id, title, status (running, done…), project, model, and whether one waits on the user. Read one with machine_read_thread; continue one with machine_run_agent and its thread_id.",
    inputSchema: {
      type: 'object',
      properties: {
        machine: machineProp,
        project: { type: 'string', description: 'Only threads of this project there (name or id)' },
        running: { type: 'boolean', description: 'Only threads that are running now' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_THREADS_LISTED,
          description: 'Maximum number of threads (default 20)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'machine_read_thread',
    readOnly: true,
    description:
      "Read the transcript of a Durango Code thread on another machine by its id there (from machine_threads or machine_run_agent). Returns the newest page of messages by default; page with offset/limit.",
    inputSchema: {
      type: 'object',
      properties: {
        machine: machineProp,
        thread_id: { type: 'string', description: 'Thread id on that machine' },
        offset: {
          type: 'integer',
          minimum: 1,
          description: '1-based index of the first message to return (oldest first). Omit for the newest messages.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum number of messages (default 30)' },
      },
      required: ['thread_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_exec',
    readOnly: false,
    description:
      "Run a shell command on another of the user's machines and get its exit code, stdout and stderr. It runs as the user there, in their login shell (cmd.exe on Windows), in their home folder unless you pass project and/or cwd. Use it for quick checks and operations there: inspect files, git status, install a tool, restart a service, tail a log. For multi-step work there, prefer machine_run_agent. Each call is a fresh shell: chain steps with && or pass a script. To write a file, pass its content as stdin to `cat > path`. Commands end at timeout_seconds (default 120, at most 600); start long-running processes with nohup and redirected output so they outlive the call.",
    inputSchema: {
      type: 'object',
      properties: {
        machine: machineProp,
        command: { type: 'string', description: 'The shell command or script to run' },
        project: {
          type: 'string',
          description: 'Run in the folder of this project there (name or id from machine_list); cwd is then relative to it',
        },
        cwd: {
          type: 'string',
          description: 'Working folder there: absolute, ~/…, or relative to project (else to the home folder)',
        },
        stdin: { type: 'string', description: 'Text sent to the command on stdin (1 MB at most)' },
        timeout_seconds: {
          type: 'integer',
          minimum: 1,
          maximum: 600,
          description: 'Seconds before the command is stopped (default 120)',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_run_agent',
    readOnly: false,
    description:
      "Run a Durango Code agent turn on another of the user's machines: a new thread there (in a project there), or a follow-up in one of its threads (thread_id). The agent works there with that machine's files, tools and logins; a thread you start shows here as a subagent of this thread (not in the user's sidebar). By default this waits until the turn ends and returns the agent's final reply; pass wait: false to start it and move on (check on it later with machine_read_thread). Give a complete, self-contained prompt: that agent does not see this conversation. Without project, a new thread runs in this thread's project there (the same Durango Source repository, cloned there if missing, else a project of the same name).",
    inputSchema: {
      type: 'object',
      properties: {
        machine: machineProp,
        prompt: { type: 'string', description: 'The complete task for the agent there, with all the context it needs' },
        thread_id: { type: 'string', description: 'Continue this thread there instead of starting a new one' },
        project: {
          type: 'string',
          description: 'For a new thread: the project there (name or id from machine_list, or "No project")',
        },
        model: {
          type: 'string',
          description:
            "Model there: id, slug or label. Default: your own model there (else your provider's model last used there) when your provider works there, else the model last used on that machine",
        },
        effort: { type: 'string', description: 'Reasoning effort, e.g. "low", "medium", "high", "xhigh"' },
        access_mode: {
          type: 'string',
          enum: ACCESS_MODES,
          description: "Access mode of the turn there (default and maximum: this thread's own)",
        },
        wait: {
          type: 'boolean',
          description: 'Wait for the turn to end and return its final reply (default true)',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_stop_agent',
    readOnly: false,
    description: 'Stop the agent turn running in a thread on another machine.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: machineProp,
        thread_id: { type: 'string', description: 'Thread id on that machine' },
      },
      required: ['thread_id'],
      additionalProperties: false,
    },
  },
]);

/** Tools listed for a run: Read only gets the read tools. */
export const machineToolsForAccessMode = (accessMode) =>
  MACHINE_TOOL_DEFINITIONS.filter((tool) => accessMode !== 'read-only' || tool.readOnly);

/** MCP tool definitions (the bridge's `__tools`): the action tools only in Full access. */
export const machineMcpToolDefinitions = (accessMode) =>
  machineToolsForAccessMode(accessMode === 'full-access' ? accessMode : 'read-only').map(({ name, description, inputSchema, readOnly }) => ({
    name,
    description,
    inputSchema,
    ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
  }));

/** System-prompt hint for Claude runs that have the tools. */
export const machineToolsPromptHint = () => {
  const state = deps.remote.getRemoteControlState();
  const names = (state?.machines ?? []).map((machine) => machine.name).filter(Boolean);
  return [
    '# Other machines (Durango Code)',
    `This machine is ${state?.machineName ?? 'this computer'}. You can also reach the user's other machines${names.length ? ` (${names.join(', ')})` : ''} with the mcp__orion__machine_* tools: run shell commands there (machine_exec), run agent threads there (machine_run_agent), and read their threads. When work belongs on another machine, do it there with these tools instead of saying you cannot reach it.`,
  ].join('\n');
};

// --- helpers ----------------------------------------------------------------

const fail = (text) => ({ ok: false, text });
const lower = (value) => String(value ?? '').trim().toLowerCase();
const basename = (value) => String(value ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';

const truncateMiddle = (text, max) => {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const half = Math.floor((max - 60) / 2);
  return `${value.slice(0, half)}\n…[${value.length - half * 2} characters omitted]…\n${value.slice(-half)}`;
};

const withTimeout = (promise, ms, message) =>
  Promise.race([
    promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: message }), ms);
      timer.unref?.();
    }),
  ]);

const unavailableText = () => {
  const state = deps.remote.getRemoteControlState();
  if (!state?.available) return 'Remote control is not available on this machine right now.';
  if (!state.authenticated) return 'Sign in to Durango Code to reach your other machines.';
  if (!(state.machines ?? []).length) {
    return 'No other machine is paired with this one. The user pairs one in Settings → Remote Control (generate a code on that machine, enter it here).';
  }
  return 'Remote control is turned off in Settings → Remote Control.';
};

/** The paired machine `ref` names (name or id, case-insensitive; unique prefix). */
const resolveMachine = (ref) => {
  if (!deps.remote.canControlRemoteMachines()) return { error: unavailableText() };
  const machines = deps.remote.getRemoteControlState()?.machines ?? [];
  const wanted = lower(ref);
  const list = () => machines.map((machine) => `${machine.name} (${machine.id})`).join(', ');
  if (!wanted) {
    if (machines.length === 1) return { machine: machines[0] };
    return { error: `Name the machine: ${list()}.` };
  }
  const exact = machines.filter((machine) => machine.id === ref || lower(machine.name) === wanted);
  if (exact.length === 1) return { machine: exact[0] };
  const prefix = machines.filter(
    (machine) => lower(machine.name).startsWith(wanted) || lower(machine.id).startsWith(wanted)
  );
  if (prefix.length === 1) return { machine: prefix[0] };
  if (exact.length > 1 || prefix.length > 1) return { error: `"${ref}" matches several machines; use the id: ${list()}.` };
  return { error: `No paired machine is called "${ref}". Paired machines: ${list()}.` };
};

const snapshotOf = async (machine) => {
  const result = await withTimeout(
    deps.remote.fetchRemoteSnapshot({ machineId: machine.id }),
    SNAPSHOT_TIMEOUT_MS,
    `${machine.name} did not answer in time.`
  );
  return result.ok && result.snapshot ? { snapshot: result.snapshot } : { error: result.error ?? `Could not reach ${machine.name}.` };
};

const projectLabel = (project) => (project?.id === NO_PROJECT_ID ? 'No project' : project?.name ?? 'Unknown project');

/** A project of a machine's snapshot by id, name, folder name or path. */
const matchProject = (projects, ref) => {
  const wanted = lower(ref);
  if (!wanted) return { project: null };
  if (wanted === 'no project' || ref === NO_PROJECT_ID) {
    return { project: projects.find((project) => project.id === NO_PROJECT_ID) ?? { id: NO_PROJECT_ID, name: 'No project' } };
  }
  const named = projects.filter(
    (project) =>
      project.id === ref ||
      lower(project.name) === wanted ||
      project.path === ref ||
      lower(basename(project.path)) === wanted
  );
  if (named.length === 1) return { project: named[0] };
  const listing = projects
    .filter((project) => project.id !== NO_PROJECT_ID)
    .map((project) => `${project.name} (${project.id})`)
    .join(', ');
  return {
    error:
      named.length > 1
        ? `"${ref}" matches several projects there; use the id: ${listing}.`
        : `No project "${ref}" there. Projects there: ${listing || 'none'}.`,
  };
};

const capAccessMode = (requested, ceiling) => {
  const limit = ACCESS_MODES.includes(ceiling) ? ceiling : 'read-only';
  const wanted = ACCESS_MODES.includes(requested) ? requested : limit;
  return ACCESS_MODES.indexOf(wanted) <= ACCESS_MODES.indexOf(limit) ? wanted : limit;
};

const refuseReadOnly = (name, context) =>
  context?.accessMode === 'read-only'
    ? fail(`${name} is not available in Read only. The user can switch this thread to Workspace write or Full access.`)
    : null;

const formatTime = (value) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (24 * 60))}d ago`;
};

// --- tools --------------------------------------------------------------------

const machineList = async () => {
  if (!deps.remote.canControlRemoteMachines()) return fail(unavailableText());
  const state = deps.remote.getRemoteControlState();
  const machines = state?.machines ?? [];
  const sections = await Promise.all(
    machines.map(async (machine) => {
      const { snapshot, error } = await snapshotOf(machine);
      const head = `## ${machine.name} (id: ${machine.id})`;
      if (!snapshot) return [head, `Not reachable now: ${error}`].join('\n');
      const threads = (snapshot.threads ?? []).filter((thread) => !thread.parentThreadId && !thread.subagent);
      const running = threads.filter((thread) => thread.status === 'running');
      const counts = new Map();
      for (const thread of threads) counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
      const projects = (snapshot.projects ?? []).map(
        (project) =>
          `- ${projectLabel(project)} (id: ${project.id})${project.path ? ` — ${project.path}` : ''}${
            counts.get(project.id) ? `, ${counts.get(project.id)} threads` : ''
          }`
      );
      return [
        head,
        'Connected.',
        'Projects:',
        ...(projects.length ? projects : ['- none']),
        running.length
          ? `Running now: ${running.map((thread) => `"${thread.title}" (${thread.id})`).join(', ')}`
          : 'No thread is running there.',
      ].join('\n');
    })
  );
  return {
    ok: true,
    text: [
      `This machine: ${state?.machineName ?? 'unknown'}. Machines you can reach:`,
      '',
      sections.join('\n\n'),
    ].join('\n'),
  };
};

const machineThreads = async (args) => {
  const { machine, error } = resolveMachine(args.machine);
  if (!machine) return fail(error);
  const { snapshot, error: snapshotError } = await snapshotOf(machine);
  if (!snapshot) return fail(snapshotError);
  const projects = snapshot.projects ?? [];
  let projectId = null;
  if (args.project) {
    const match = matchProject(projects, args.project);
    if (!match.project) return fail(match.error);
    projectId = match.project.id;
  }
  const limit = Math.min(MAX_THREADS_LISTED, Math.max(1, Number.isInteger(args.limit) ? args.limit : 20));
  const byId = new Map(projects.map((project) => [project.id, project]));
  const threads = (snapshot.threads ?? [])
    .filter((thread) => !thread.parentThreadId && !thread.subagent && thread.messageCount !== 0)
    .filter((thread) => !projectId || thread.projectId === projectId)
    .filter((thread) => args.running !== true || thread.status === 'running')
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
  if (threads.length === 0) return { ok: true, text: `No matching threads on ${machine.name}.` };
  const lines = threads.slice(0, limit).map((thread) => {
    const flags = [
      thread.status,
      thread.waitingOnQuestion || thread.userActions?.length ? 'needs the user' : null,
      thread.workspaceName ? `workspace ${thread.workspaceName}` : null,
    ].filter(Boolean);
    return `- ${thread.id} — "${thread.title}" [${flags.join(', ')}] · ${projectLabel(byId.get(thread.projectId))} · ${
      thread.modelId ?? 'model?'
    } · ${thread.messageCount ?? 0} messages · ${formatTime(thread.updatedAt)}`;
  });
  return {
    ok: true,
    text: [
      `Threads on ${machine.name} (${Math.min(limit, threads.length)} of ${threads.length}, most recent first):`,
      ...lines,
    ].join('\n'),
  };
};

const fetchThread = async (machine, threadId) => {
  const result = await deps.remote.fetchRemoteThread({ machineId: machine.id, threadId });
  if (!result.ok || !result.thread) return { error: result.error ?? `Could not read that thread on ${machine.name}.` };
  return { thread: result.thread };
};

const machineReadThread = async (args) => {
  const { machine, error } = resolveMachine(args.machine);
  if (!machine) return fail(error);
  const threadId = String(args.thread_id ?? '').trim();
  if (!threadId) return fail('machine_read_thread requires `thread_id`.');
  const { thread, error: threadError } = await fetchThread(machine, threadId);
  if (!thread) return fail(threadError);
  return {
    ok: true,
    text: formatThreadForAgent(thread, {
      offset: args.offset,
      limit: args.limit,
      toolCall: 'machine_read_thread',
      extraHeader: [`machine: ${machine.name} (id: ${machine.id})`],
      link: false,
    }),
  };
};

const formatExecResult = (machine, command, result) => {
  const status = result.timedOut
    ? 'timed out (stopped)'
    : result.cancelled
      ? 'cancelled'
      : result.signal
        ? `killed by ${result.signal}`
        : `exit code ${result.exitCode}`;
  const budget = Math.floor(MAX_OUTPUT_CHARS / 2);
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const section = (label, text, truncated) =>
    text.trim()
      ? [`--- ${label}${truncated ? ' (middle omitted there)' : ''} ---`, truncateMiddle(text.replace(/\s+$/, ''), stdout && stderr ? budget : MAX_OUTPUT_CHARS)]
      : [];
  return [
    `$ ${truncateMiddle(command, 500)}`,
    `On ${machine.name} in ${result.cwd ?? '?'}: ${status} after ${((result.durationMs ?? 0) / 1000).toFixed(1)}s.`,
    ...section('stdout', stdout, result.stdoutTruncated),
    ...section('stderr', stderr, result.stderrTruncated),
    ...(!stdout.trim() && !stderr.trim() ? ['(no output)'] : []),
  ].join('\n');
};

const machineExec = async (args, context) => {
  const refused = refuseReadOnly('machine_exec', context);
  if (refused) return refused;
  const { machine, error } = resolveMachine(args.machine);
  if (!machine) return fail(error);
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command.trim()) return fail('machine_exec requires a `command`.');
  let projectId;
  if (args.project) {
    const { snapshot, error: snapshotError } = await snapshotOf(machine);
    if (!snapshot) return fail(snapshotError);
    const match = matchProject(snapshot.projects ?? [], args.project);
    if (!match.project) return fail(match.error);
    projectId = match.project.id;
  }
  if (context?.signal?.aborted) return fail('This run was stopped; the command was not sent.');
  const result = await deps.remote.execOnRemoteMachine({
    machineId: machine.id,
    command,
    cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
    projectId,
    stdin: typeof args.stdin === 'string' ? args.stdin : undefined,
    timeoutMs: Number.isInteger(args.timeout_seconds) ? args.timeout_seconds * 1000 : undefined,
    signal: context?.signal,
  });
  if (!result.ok) return fail(`Could not run the command on ${machine.name}: ${result.error}`);
  return {
    ok: !result.timedOut && !result.cancelled && result.exitCode === 0,
    text: formatExecResult(machine, command, result),
  };
};

const matchModel = (models, ref) => {
  const wanted = lower(ref);
  const usable = models.filter((model) => model.available !== false);
  const exact = usable.filter(
    (model) => model.id === ref || lower(model.slug) === wanted || lower(model.label) === wanted
  );
  if (exact.length >= 1) return { model: exact[0] };
  const loose = usable.filter(
    (model) => lower(model.id).includes(wanted) || lower(model.label).includes(wanted) || lower(model.slug).includes(wanted)
  );
  if (loose.length === 1) return { model: loose[0] };
  const listing = usable
    .slice(0, 40)
    .map((model) => `${model.label || model.slug} (${model.id})`)
    .join(', ');
  return {
    error:
      loose.length > 1
        ? `"${ref}" matches several models there: ${loose.map((model) => model.id).join(', ')}.`
        : `No available model "${ref}" there. Models there: ${listing}.`,
  };
};

const providerOfModelId = (modelId) => (typeof modelId === 'string' && modelId.includes(':') ? modelId.split(':')[0] : '');
const listedTime = (thread) => Date.parse(thread?.updatedAt ?? thread?.createdAt ?? '') || 0;

/**
 * The model a new thread there runs when the caller names none. The calling
 * agent's own model when that machine has it, else the model of the same
 * provider last used there, else any model of that provider there (a Claude
 * agent starts Claude there); without one, the model last used on that
 * machine. null = leave it to that machine (its project's last model).
 */
export const defaultRemoteModel = ({ models, threads, callerModelId, callerProviderId }) => {
  const usable = (Array.isArray(models) ? models : []).filter(
    (model) => model && typeof model.id === 'string' && model.available !== false
  );
  const byId = new Map(usable.map((model) => [model.id, model]));
  // Threads someone actually ran (not untouched drafts), newest first.
  const recent = (Array.isArray(threads) ? threads : [])
    .filter(
      (thread) =>
        thread &&
        !thread.parentThreadId &&
        !thread.subagent &&
        thread.messageCount !== 0 &&
        byId.has(thread.modelId)
    )
    .sort((a, b) => listedTime(b) - listedTime(a));
  const provider = callerProviderId || providerOfModelId(callerModelId);
  if (provider) {
    if (callerModelId && byId.get(callerModelId)?.providerId === provider) return byId.get(callerModelId);
    const used = recent.find((thread) => byId.get(thread.modelId).providerId === provider);
    if (used) return byId.get(used.modelId);
    const ofProvider = usable.filter((model) => model.providerId === provider);
    const pick = ofProvider.find((model) => model.favorite) ?? ofProvider[0];
    if (pick) return pick;
  }
  return recent.length > 0 ? byId.get(recent[0].modelId) : null;
};

// Threads started here by machine_run_agent, by machine and that machine's
// thread id → the thread here whose agent started it. A host lists its
// own record of this (`spawnedBy`); this covers an older one that doesn't.
const spawnedRemoteThreads = new Map();
const spawnKey = (machineId, hostThreadId) => `${machineId}\u0000${hostThreadId}`;

/** The thread here that started `hostThreadId` on that machine with machine_run_agent, if known. */
export const remoteThreadSpawner = (machineId, hostThreadId) =>
  spawnedRemoteThreads.get(spawnKey(machineId, hostThreadId)) ?? null;

/**
 * The reply to `prompt` in a thread: the agent messages after the user
 * message with that text, up to the next user message (a later follow-up's
 * reply is not this turn's). `fromIndex`: the turn's user message is at or
 * after it (the transcript length before the turn started), so an earlier
 * message with the same text is not taken for it.
 */
const replyAfterPrompt = (thread, prompt, fromIndex = 0) => {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const wanted = String(prompt ?? '').trim();
  let start = -1;
  for (let index = Math.max(0, fromIndex); index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === 'user' && String(message.content ?? '').trim() === wanted) {
      start = index;
      break;
    }
  }
  if (start === -1) return null;
  const replies = [];
  let laterTurn = false;
  for (const message of messages.slice(start + 1)) {
    if (message?.role === 'user') {
      laterTurn = true;
      break;
    }
    if (message?.role === 'agent') replies.push(message);
  }
  return {
    replies,
    laterTurn,
    finished: replies.length > 0 && replies.every((message) => message.status !== 'running'),
  };
};

/** This turn's reply once it has ended (a later turn may already be running). */
const turnEnded = (thread, prompt, fromIndex) => {
  if (!thread) return null;
  const reply = replyAfterPrompt(thread, prompt, fromIndex);
  return reply?.finished && (reply.laterTurn || thread.status !== 'running') ? reply : null;
};

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

/**
 * Waits for the turn `prompt` started in `threadId` there to end → the
 * thread, or { stopped } when this run was stopped or the machine stayed
 * unreachable. `ended` holds threads whose end event already came.
 */
const waitForTurn = async ({ machine, threadId, prompt, fromIndex, signal, ended, onEnd }) => {
  let failedPolls = 0;
  for (;;) {
    if (signal?.aborted) return { stopped: 'This run was stopped; the turn there keeps running.' };
    if (!ended.has(threadId)) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, WAIT_POLL_MS);
        function done() {
          clearTimeout(timer);
          onEnd.delete(done);
          signal?.removeEventListener?.('abort', done);
          resolve();
        }
        onEnd.add(done);
        signal?.addEventListener?.('abort', done, { once: true });
      });
      if (signal?.aborted) continue;
    }
    const eventSaysEnded = ended.has(threadId);
    // The end event can come before the transcript there is saved: re-read
    // it a few times.
    for (let attempt = 0; attempt < (eventSaysEnded ? 6 : 1); attempt += 1) {
      const { thread, error } = await fetchThread(machine, threadId);
      if (!thread) {
        failedPolls += 1;
        if (failedPolls >= WAIT_MAX_FAILED_POLLS) {
          return { stopped: `Lost touch with ${machine.name} (${error}); the turn there may still be running.` };
        }
        break;
      }
      failedPolls = 0;
      if (turnEnded(thread, prompt, fromIndex)) return { thread };
      if (eventSaysEnded) await sleep(1_000, signal);
    }
    if (eventSaysEnded) {
      // Ended, but the reply could not be told apart (e.g. the prompt was
      // rewritten there): report the thread as it is.
      const { thread } = await fetchThread(machine, threadId);
      if (thread && thread.status !== 'running') return { thread };
      ended.delete(threadId);
    }
  }
};

const lastTurnReply = (thread, prompt, fromIndex) => {
  const reply = replyAfterPrompt(thread, prompt, fromIndex);
  return reply?.replies.at(-1) ?? [...(thread.messages ?? [])].reverse().find((message) => message?.role === 'agent');
};

const turnWasStopped = (thread, prompt, fromIndex) => lastTurnReply(thread, prompt, fromIndex)?.status === 'stopped';

const formatTurnResult = (machine, thread, prompt, fromIndex) => {
  const last = lastTurnReply(thread, prompt, fromIndex);
  const status = last?.status === 'error' ? 'failed' : last?.status === 'stopped' ? 'was stopped' : 'finished';
  const content = String(last?.content ?? '').trim();
  return [
    `The turn on ${machine.name} ${status} — thread "${thread.title}" (id: ${thread.id}).`,
    '',
    content ? truncateMiddle(content, MAX_REPLY_CHARS) : '(The agent there gave no final reply.)',
    '',
    `Read the full transcript, tool activity included, with machine_read_thread (machine: "${machine.name}", thread_id: "${thread.id}").`,
  ].join('\n');
};

const machineRunAgent = async (args, context) => {
  const refused = refuseReadOnly('machine_run_agent', context);
  if (refused) return refused;
  const { machine, error } = resolveMachine(args.machine);
  if (!machine) return fail(error);
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return fail('machine_run_agent requires a `prompt`.');
  const threadId = typeof args.thread_id === 'string' && args.thread_id.trim() ? args.thread_id.trim() : null;

  // Where a new thread runs there.
  let projectId;
  let projectName;
  if (!threadId) {
    if (args.project) {
      const { snapshot, error: snapshotError } = await snapshotOf(machine);
      if (!snapshot) return fail(snapshotError);
      const match = matchProject(snapshot.projects ?? [], args.project);
      if (!match.project) return fail(match.error);
      projectId = match.project.id;
      projectName = projectLabel(match.project);
    } else {
      const resolved = await deps.resolveCallerProject({ machineId: machine.id, projectPath: context?.projectPath });
      if (!resolved.ok) {
        return fail(
          `${resolved.error ?? 'Could not find this project there.'} Pass project (see machine_list) to pick one, or "No project".`
        );
      }
      projectId = resolved.projectId;
      projectName = resolved.projectName;
    }
  }

  let modelId;
  if (typeof args.model === 'string' && args.model.trim()) {
    const catalog = await deps.remote.fetchRemoteModels({ machineId: machine.id });
    if (!catalog.ok) return fail(`Could not list the models on ${machine.name}: ${catalog.error}`);
    const match = matchModel(catalog.models, args.model.trim());
    if (!match.model) return fail(match.error);
    modelId = match.model.id;
  } else if (!threadId) {
    // No model named: this agent's provider when it works there, else what
    // that machine ran last; never a model nobody uses there. Unreadable →
    // that machine's own default.
    const [catalog, listing] = await Promise.all([
      deps.remote.fetchRemoteModels({ machineId: machine.id }).catch(() => null),
      snapshotOf(machine).catch(() => ({})),
    ]);
    if (catalog?.ok) {
      modelId =
        defaultRemoteModel({
          models: catalog.models,
          threads: listing?.snapshot?.threads,
          callerModelId: context?.modelId,
          callerProviderId: context?.providerId,
        })?.id ?? undefined;
    }
  }

  // A follow-up's reply comes after the transcript as it is now: an earlier
  // message with the same text is not this turn's.
  let fromIndex = 0;
  if (threadId && args.wait !== false) {
    const { thread: before, error: beforeError } = await fetchThread(machine, threadId);
    // Without it a repeated prompt could be answered with an earlier reply.
    if (!before) return fail(`Could not read thread ${threadId} on ${machine.name}: ${beforeError}`);
    fromIndex = Array.isArray(before.messages) ? before.messages.length : 0;
  }
  if (context?.signal?.aborted) return fail('This run was stopped; nothing was started there.');

  // Ends of turns there, collected from before the turn starts so a quick
  // one is not missed.
  const ended = new Set();
  const onEnd = new Set();
  const wait = args.wait !== false;
  const unsubscribe = wait
    ? deps.remote.addRemoteEventListener((event) => {
        if (event?.machineId !== machine.id || event.kind !== 'turnEvent') return;
        const payload = event.payload;
        if ((payload?.type === 'done' || payload?.type === 'error') && typeof payload.threadId === 'string') {
          ended.add(payload.threadId);
          for (const resolve of [...onEnd]) resolve();
        }
      })
    : () => {};
  try {
    const started = await deps.remote.runRemoteTurn({
      machineId: machine.id,
      ...(threadId ? { threadId } : { projectId }),
      prompt,
      ...(modelId ? { modelId } : {}),
      accessMode: capAccessMode(args.access_mode, context?.accessMode),
      ...(typeof args.effort === 'string' && args.effort.trim() ? { reasoningEffort: args.effort.trim().toLowerCase() } : {}),
      // A new thread there is this thread's subagent: shown under it here,
      // not in the sidebars.
      ...(!threadId && typeof context?.threadId === 'string' && context.threadId
        ? { spawnedBy: { threadId: context.threadId } }
        : {}),
    });
    if (!started.ok || !started.threadId) {
      return fail(`Could not start the turn on ${machine.name}: ${started.error ?? 'no thread was started.'}`);
    }
    if (!threadId && typeof context?.threadId === 'string' && context.threadId) {
      spawnedRemoteThreads.set(spawnKey(machine.id, started.threadId), context.threadId);
    }
    const where = threadId ? `thread ${started.threadId}` : `a new thread (id: ${started.threadId}) in ${projectName ?? 'a project'}`;
    if (!wait) {
      return {
        ok: true,
        text: `Started a turn on ${machine.name} in ${where}.${threadId ? '' : ' It shows here as a subagent of this thread.'} Check on it with machine_read_thread (machine: "${machine.name}", thread_id: "${started.threadId}").`,
      };
    }
    const outcome = await waitForTurn({
      machine,
      threadId: started.threadId,
      prompt,
      fromIndex,
      signal: context?.signal,
      ended,
      onEnd,
    });
    if (outcome.stopped) {
      return {
        ok: false,
        text: `${outcome.stopped} Started on ${machine.name} in ${where}; check on it with machine_read_thread.`,
      };
    }
    // `stopped`: the turn there was stopped (by the user), not finished.
    return {
      ok: true,
      text: formatTurnResult(machine, outcome.thread, prompt, fromIndex),
      ...(turnWasStopped(outcome.thread, prompt, fromIndex) ? { stopped: true } : {}),
    };
  } finally {
    unsubscribe();
  }
};

const machineStopAgent = async (args, context) => {
  const refused = refuseReadOnly('machine_stop_agent', context);
  if (refused) return refused;
  const { machine, error } = resolveMachine(args.machine);
  if (!machine) return fail(error);
  const threadId = String(args.thread_id ?? '').trim();
  if (!threadId) return fail('machine_stop_agent requires `thread_id`.');
  const result = await deps.remote.stopRemoteTurn({ machineId: machine.id, threadId });
  return result.ok
    ? { ok: true, text: `Stopped the turn in thread ${threadId} on ${machine.name}.` }
    : fail(`Could not stop it on ${machine.name}: ${result.error}`);
};

const HANDLERS = {
  machine_list: machineList,
  machine_threads: machineThreads,
  machine_read_thread: machineReadThread,
  machine_exec: machineExec,
  machine_run_agent: machineRunAgent,
  machine_stop_agent: machineStopAgent,
};

/**
 * Runs one machine tool. `context`: { accessMode, projectPath, signal }.
 * Resolves (never rejects) with { ok, text }.
 */
export const runMachineTool = async (name, rawArgs, context = {}) => {
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool: ${name}`);
  if (context.accessMode === 'read-only' && !ORION_MACHINE_READ_TOOL_NAMES.includes(name)) {
    return refuseReadOnly(name, context);
  }
  if (
    context.requireFullAccess &&
    context.accessMode !== 'full-access' &&
    !ORION_MACHINE_READ_TOOL_NAMES.includes(name)
  ) {
    return fail(
      `${name} needs Full access for this provider, which can't ask the user before each command or turn. The user can switch this thread to Full access.`
    );
  }
  try {
    await deps.ready;
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    return await handler(args, context);
  } catch (error) {
    return fail(`${name} failed: ${error?.message ?? error}`);
  }
};
