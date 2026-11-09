import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Secret requests on Durango Code's built-in `orion` MCP server
// (request_secret): an agent that needs a value only the user has (an API key,
// a token, a password, a PIN or pairing code) asks for it through a private
// input card instead of in chat. The value never enters the conversation.
// Two deliveries:
// - `file` (default): the app writes it to an owner-only file and the agent
//   gets the path, which it reads inside the command that needs it
//   (`"$(cat <file>)"`).
// - `ref`: the value stays in this process's memory and the agent gets a
//   secret ref (`dsr_<hex>`), valid in that thread for 24 hours. Tools that
//   take secrets swap a ref in their arguments for the value
//   (resolveSecretRefs): the built-in browser's browser_type and
//   browser_evaluate (browser-tools.js), apps connected through Durango Code
//   (call_app_tool on the bridge, mcp-bridge.js; for Claude every non-orion
//   MCP tool, through the hooks in claude-driver.js). Their output is scrubbed
//   of the value before the model reads it.
//
// Unlike request_user_action the call blocks: the agent's next step needs the
// value. It ends when the user saves or declines, when it times out, or when
// the run that asked ends (its bridge session is released, its Claude session
// disposed, or the SDK aborts the call). The card rides on the thread's user
// actions (agent:userAction) so the thread is flagged as needing the user;
// a `resolve` clears it whichever way the request ends.
//
// Saved values are kept in memory too, so agent events sent to the renderer
// and remote control are scrubbed of them (redactSecrets, events.js): a value
// an agent prints by mistake does not end up in the thread's saved history.
//
// Claude runs register the tool on the in-process SDK server
// (claude-driver.js); every other provider reaches it through the stdio
// bridge shim (mcp-bridge-shim.cjs → mcp-bridge.js). The shim duplicates the
// description and schema below; test-durango-tools.mjs keeps them in sync.

export const SECRET_TOOL_NAMES = Object.freeze(['request_secret']);

export const SECRET_LABEL_MAX_CHARS = 120;
export const SECRET_REASON_MAX_CHARS = 1_000;
export const SECRET_VALUE_MAX_CHARS = 16_384;
export const SECRET_TIMEOUT_DEFAULT_S = 600;
export const SECRET_TIMEOUT_MIN_S = 30;
export const SECRET_TIMEOUT_MAX_S = 3_600;
export const SECRET_FILE_TTL_MS = 24 * 60 * 60_000;
export const SECRET_DELIVERIES = Object.freeze(['file', 'ref']);
// `dsr_` + 32 hex: distinctive enough to find inside a larger string
// ("Bearer dsr_…") without matching anything else.
export const SECRET_REF_PATTERN = /dsr_[0-9a-f]{32}/g;
// Marks tool arguments that carry a secret from a ref (browser_type).
export const SECRET_TYPED = Symbol.for('durango.secretTyped');
// Shorter values (a 3-digit code) would scrub ordinary text.
export const SECRET_REDACT_MIN_CHARS = 4;
export const SECRET_REDACTED = '[secret]';

export const SECRET_TOOL_DESCRIPTIONS = Object.freeze({
  request_secret:
    'Ask the user for one secret only they have, such as an API key, access token, password, sudo password, PIN, 2FA or pairing code, through a private input card in Durango Code. Use it instead of asking in chat or telling the user to run the command themselves, and call it as soon as the next step needs the value (do not just offer to). Not for access you already have (env, vault, a logged-in CLI). The value never enters this conversation. With `delivery: "file"` (the default, for shell commands) Durango Code saves it to an owner-only file and returns the path: read the file only inside the command that needs it, e.g. `adb pair 192.168.1.42:37099 "$(cat <file>)"`, `CLOUDFLARE_API_TOKEN="$(cat <file>)" wrangler deploy` or `sudo -S -p \'\' <cmd> < <file>`. With `delivery: "ref"` (for tools) it returns a secret ref (`dsr_…`) that you pass in place of the value to a tool that takes secrets: browser_type or browser_evaluate in the built-in browser (sign-in forms), or a tool of an app connected through Durango Code (its arguments, e.g. "Bearer dsr_…"). The tool gets the value; you see only the ref, and its output comes back with the value replaced by [secret]. Never print, echo or log the value, and never copy it into code, commits, prompts, subagent briefs, memory or replies; write it into a file only where the task needs it (a gitignored .env the user asked for). One value per call; ask again for a second one. The call waits until the user answers (10 minutes by default). If they decline, do not ask again in chat or another way: say what is blocked and go on without it. After a timeout or cancellation, ask again only if it is still needed. If the user already pasted the secret in this thread, pass it as `value` to save it without a card, and pass the file or ref instead of the value from then on. Files and refs expire after 24 hours; a ref works only in this thread.',
});

export const SECRET_TOOL_INPUT_SCHEMAS = Object.freeze({
  request_secret: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'What the value is, as the card title, e.g. "Cloudflare API token" or "Pixel pairing code"',
      },
      reason: {
        type: 'string',
        description:
          'One or two sentences for the card: what you will use it for and where the user finds or creates it (scopes or permissions to pick, a code on a screen).',
      },
      url: {
        type: 'string',
        description: 'Page where the user gets or creates the value, if any (shown as an Open button)',
      },
      placeholder: {
        type: 'string',
        description: 'Hint shown in the empty input, e.g. "sk_test_…" or "6-digit code"',
      },
      delivery: {
        type: 'string',
        enum: ['file', 'ref'],
        description:
          'file (default): an owner-only file for shell commands. ref: a secret ref for browser_type, browser_evaluate or a connected app tool.',
      },
      value: {
        type: 'string',
        description:
          'Only for a secret the user already pasted in this thread: saves it without showing a card, so you can pass the file or ref on instead of the value.',
      },
      timeout_seconds: {
        type: 'integer',
        minimum: SECRET_TIMEOUT_MIN_S,
        maximum: SECRET_TIMEOUT_MAX_S,
        description: `How long to wait for the user, in seconds (default ${SECRET_TIMEOUT_DEFAULT_S})`,
      },
    },
    required: ['label', 'reason'],
    additionalProperties: false,
  },
});

export const SECRET_UNSAVED_NOTES = Object.freeze({
  declined:
    'The user declined to give it. Do not ask for it again, in chat or any other way: say what is blocked without it and carry on with the rest.',
  timed_out:
    'The user did not answer in time. Do not ask in chat; call request_secret again only if the value is still needed.',
  cancelled:
    'The request closed before the user answered (the run stopped). Call request_secret again only if the value is still needed.',
});

let secretsDir = path.join(os.homedir(), '.durango', 'secrets');
export const secretFilesDir = () => secretsDir;
export const setSecretsDirForTests = (dir) => {
  secretsDir = dir;
};

const pendingSecretRequests = new Map(); // id -> { threadId, owner, resolve, timer, cleanup }
// Every value saved this run, for scrubbing: file path or ref -> { value, expiresAt }.
const savedSecretValues = new Map();
const secretRefs = new Map(); // ref -> { value, threadId, expiresAt }

const sendToRenderer = (getSender, payload) => {
  const sender = getSender?.();
  if (!sender || sender.isDestroyed?.()) return false;
  try {
    sender.send('agent:userAction', payload);
    return true;
  } catch {
    return false;
  }
};

const httpUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const optionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

// A pasted value keeps inner spaces but not the newline a copy often brings.
const cleanSecretValue = (value) => (typeof value === 'string' ? value.replace(/^[\r\n]+|[\r\n]+$/g, '') : '');

const ensureSecretsDir = async () => {
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to a directory it creates.
  if (process.platform !== 'win32') await fs.chmod(secretsDir, 0o700);
};

/** Deletes saved secret files older than SECRET_FILE_TTL_MS; never throws. */
export const sweepExpiredSecretFiles = async (now = Date.now()) => {
  for (const [key, entry] of savedSecretValues) {
    if (entry.expiresAt <= now) savedSecretValues.delete(key);
  }
  for (const [ref, entry] of secretRefs) {
    if (entry.expiresAt <= now) secretRefs.delete(ref);
  }
  let names;
  try {
    names = await fs.readdir(secretsDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue;
    const file = path.join(secretsDir, name);
    try {
      const stat = await fs.stat(file);
      if (now - stat.mtimeMs < SECRET_FILE_TTL_MS) continue;
      await fs.rm(file, { force: true });
      savedSecretValues.delete(file);
      removed += 1;
    } catch {}
  }
  return removed;
};

// While the app runs, expired files go within the hour, not only at the next
// launch or save.
let sweepTimer = null;
export const startSecretFileSweeps = (intervalMs = 60 * 60_000) => {
  if (sweepTimer) return;
  void sweepExpiredSecretFiles();
  sweepTimer = setInterval(() => void sweepExpiredSecretFiles(), intervalMs);
  sweepTimer.unref?.();
};

/** Writes `value` to a new owner-only file and returns its path. */
export const saveSecretFile = async (value) => {
  await ensureSecretsDir();
  const file = path.join(secretsDir, crypto.randomBytes(16).toString('hex'));
  await fs.writeFile(file, value, { mode: 0o600, flag: 'wx' });
  savedSecretValues.set(file, { value, expiresAt: Date.now() + SECRET_FILE_TTL_MS });
  void sweepExpiredSecretFiles();
  return file;
};

/** Keeps `value` in memory under a new ref for `threadId` and returns the ref. */
export const saveSecretRef = (value, threadId) => {
  const ref = `dsr_${crypto.randomBytes(16).toString('hex')}`;
  const expiresAt = Date.now() + SECRET_FILE_TTL_MS;
  secretRefs.set(ref, { value, threadId, expiresAt });
  savedSecretValues.set(ref, { value, expiresAt });
  return ref;
};

const saveSecret = async (value, delivery, threadId) =>
  delivery === 'ref' ? { ref: saveSecretRef(value, threadId) } : { file: await saveSecretFile(value) };

const forgetSecret = async ({ file, ref }) => {
  if (ref) {
    secretRefs.delete(ref);
    savedSecretValues.delete(ref);
  }
  if (file) {
    savedSecretValues.delete(file);
    await fs.rm(file, { force: true }).catch(() => {});
  }
};

const shellQuote = (file) => (/^[\w./~-]+$/.test(file) ? file : `'${file.replace(/'/g, `'\\''`)}'`);

const savedText = ({ file, ref }, { pasted = false } = {}) => {
  const who = pasted ? 'Saved the value you passed' : 'The user saved the secret';
  if (ref) {
    return [
      `${who} as the secret ref ${ref} (works in this thread for 24 hours).`,
      'Pass the ref in place of the value to browser_type or browser_evaluate in the built-in browser, or in the arguments of a tool of an app connected through Durango Code; the tool gets the value and its output comes back with the value replaced by [secret]. Other tools and commands get the ref as plain text: for a shell command, ask again with delivery "file".',
    ].join(' ');
  }
  const quoted = shellQuote(file);
  return [
    `${who} to ${quoted} (owner-only, deleted after 24 hours).`,
    `Read it only inside the command that needs it, e.g. "$(cat ${quoted})" or < ${quoted}; never print or copy the value, and pass the path, not the value, to anything else.`,
  ].join(' ');
};

const unsavedText = (status) => `Not saved (${status}). ${SECRET_UNSAVED_NOTES[status]}`;

const unavailable =
  'Durango Code could not show the secret card: its window is no longer available. Say in your reply what is blocked without the secret; do not ask for it in chat.';

/**
 * Runs request_secret for the thread `threadId`. Resolves to `{ ok, text }`
 * once the request ends; never throws. `owner` identifies the run that asked
 * (cancelSecretRequests({ owner }) closes its cards); `signal` aborts it.
 */
export const runSecretTool = async (name, args, { getSender, threadId, owner, signal }) => {
  if (name !== 'request_secret') return { ok: false, text: `Unknown tool: ${name}` };
  if (!threadId) return { ok: false, text: 'This agent run is not attached to a Durango Code thread.' };
  const label = optionalString(args?.label);
  const reason = optionalString(args?.reason);
  if (!label || !reason) {
    return { ok: false, text: 'request_secret requires non-empty string `label` and `reason` arguments.' };
  }
  if (label.length > SECRET_LABEL_MAX_CHARS) {
    return { ok: false, text: `Keep \`label\` under ${SECRET_LABEL_MAX_CHARS} characters: it is the card title.` };
  }
  if (reason.length > SECRET_REASON_MAX_CHARS) {
    return { ok: false, text: `Keep \`reason\` under ${SECRET_REASON_MAX_CHARS} characters: one or two sentences.` };
  }
  if (args?.url !== undefined && !httpUrl(args.url)) {
    return { ok: false, text: '`url` must be an http(s) link; leave it out if there is none.' };
  }
  const timeoutSeconds = args?.timeout_seconds ?? SECRET_TIMEOUT_DEFAULT_S;
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < SECRET_TIMEOUT_MIN_S ||
    timeoutSeconds > SECRET_TIMEOUT_MAX_S
  ) {
    return {
      ok: false,
      text: `\`timeout_seconds\` must be a whole number from ${SECRET_TIMEOUT_MIN_S} to ${SECRET_TIMEOUT_MAX_S}.`,
    };
  }
  if (args?.delivery !== undefined && !SECRET_DELIVERIES.includes(args.delivery)) {
    return { ok: false, text: '`delivery` must be "file" (for commands) or "ref" (for tools).' };
  }
  const delivery = args?.delivery ?? 'file';
  if (args?.value !== undefined) {
    const value = cleanSecretValue(args.value);
    if (!value.trim()) return { ok: false, text: '`value` is empty; leave it out to ask the user instead.' };
    if (value.length > SECRET_VALUE_MAX_CHARS) {
      return { ok: false, text: `\`value\` is over ${SECRET_VALUE_MAX_CHARS} characters.` };
    }
    try {
      return { ok: true, text: savedText(await saveSecret(value, delivery, threadId), { pasted: true }) };
    } catch (error) {
      return { ok: false, text: `Could not save the value: ${error?.message ?? error}` };
    }
  }
  if (signal?.aborted) return { ok: true, text: unsavedText('cancelled') };

  const id = `sr_${crypto.randomUUID().slice(0, 8)}`;
  const url = httpUrl(args?.url);
  const placeholder = optionalString(args?.placeholder)?.slice(0, 80);
  const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();
  return new Promise((resolve) => {
    const onAbort = () => finishSecretRequest(id, { status: 'cancelled' });
    const entry = {
      threadId,
      owner,
      delivery,
      getSender,
      resolve,
      timer: setTimeout(() => finishSecretRequest(id, { status: 'timed_out' }), timeoutSeconds * 1000),
      cleanup: () => signal?.removeEventListener('abort', onAbort),
    };
    entry.timer.unref?.();
    pendingSecretRequests.set(id, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    const shown = sendToRenderer(getSender, {
      type: 'request',
      threadId,
      id,
      action: label,
      ...(url ? { url } : {}),
      secret: { label, reason, ...(placeholder ? { placeholder } : {}), delivery, expiresAt },
    });
    if (!shown) {
      pendingSecretRequests.delete(id);
      clearTimeout(entry.timer);
      entry.cleanup();
      resolve({ ok: false, text: unavailable });
    }
  });
};

// Ends request `id` once: tells the agent and clears the card.
const finishSecretRequest = (id, { status, saved }) => {
  const entry = pendingSecretRequests.get(id);
  if (!entry) return false;
  pendingSecretRequests.delete(id);
  clearTimeout(entry.timer);
  entry.cleanup();
  sendToRenderer(entry.getSender, { type: 'resolve', threadId: entry.threadId, id, source: 'secret' });
  entry.resolve({ ok: true, text: status === 'saved' ? savedText(saved) : unsavedText(status) });
  return true;
};

const ENDED = 'This request has ended: the agent that asked stopped or stopped waiting.';

/** Ids of the secret requests still waiting on the user. */
export const listPendingSecretRequests = () =>
  [...pendingSecretRequests].map(([id, entry]) => ({ id, threadId: entry.threadId }));

/**
 * The user's answer from the card: `{ type: 'save', value }` or
 * `{ type: 'decline' }`. Resolves `{ ok: true }`, or `{ ok: false, error }`
 * (with `ended` when the request is gone; otherwise the card stays so the
 * user can try again).
 */
export const answerSecretRequest = async ({ threadId, id, answer } = {}) => {
  const entry = typeof id === 'string' ? pendingSecretRequests.get(id) : undefined;
  if (!entry || entry.threadId !== threadId) {
    return { ok: false, ended: true, error: ENDED };
  }
  if (answer?.type === 'decline') {
    finishSecretRequest(id, { status: 'declined' });
    return { ok: true };
  }
  if (answer?.type !== 'save') return { ok: false, error: 'Unknown answer.' };
  const value = cleanSecretValue(answer.value);
  if (!value.trim()) return { ok: false, error: 'Enter a value, or decline.' };
  if (value.length > SECRET_VALUE_MAX_CHARS) return { ok: false, error: 'That value is too long.' };
  let saved;
  try {
    saved = await saveSecret(value, entry.delivery, entry.threadId);
  } catch (error) {
    return { ok: false, error: `Could not save it: ${error?.message ?? error}` };
  }
  if (!finishSecretRequest(id, { status: 'saved', saved })) {
    // Ended while it was saved: nobody will use it.
    await forgetSecret(saved);
    return { ok: false, ended: true, error: ENDED };
  }
  return { ok: true };
};

/** Closes pending requests of `owner` and/or `threadId` as cancelled. */
export const cancelSecretRequests = ({ owner, threadId } = {}) => {
  if (!owner && !threadId) return 0;
  let cancelled = 0;
  for (const [id, entry] of [...pendingSecretRequests]) {
    if ((owner && entry.owner !== owner) || (threadId && entry.threadId !== threadId)) continue;
    if (finishSecretRequest(id, { status: 'cancelled' })) cancelled += 1;
  }
  return cancelled;
};

// --- Handing refs to tools ------------------------------------------------------------------

// `input` with every string passed through `map`; the same object when
// nothing changed. Only plain objects and arrays are walked.
const mapStringsDeep = (input, map, depth = 0) => {
  if (typeof input === 'string') return map(input);
  if (!input || typeof input !== 'object' || depth > 12) return input;
  if (Array.isArray(input)) {
    let changed = false;
    const out = input.map((item) => {
      const next = mapStringsDeep(item, map, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : input;
  }
  // Leave buffers, dates and class instances alone.
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return input;
  let out = input;
  for (const [key, item] of Object.entries(input)) {
    const next = mapStringsDeep(item, map, depth + 1);
    if (next === item) continue;
    if (out === input) out = { ...input };
    out[key] = next;
  }
  return out;
};

/** Whether any string in `input` contains a secret ref. */
export const hasSecretRef = (input) => {
  let found = false;
  mapStringsDeep(input, (text) => {
    if (!found && text.includes('dsr_')) found = new RegExp(SECRET_REF_PATTERN.source).test(text);
    return text;
  });
  return found;
};

/**
 * Tool arguments with every secret ref of `threadId` replaced by its value
 * (`encode` turns the value into its replacement, e.g. a JS string literal).
 * Resolves `{ ok: true, value, used, values }` (`values`: the secrets it put
 * in, for redactSecrets' `alsoValues`; `value` is `input` itself when it
 * holds no ref) or `{ ok: false, text }` for a ref that is unknown, expired
 * or another thread's, so the call fails instead of sending the ref.
 */
export const resolveSecretRefs = (input, { threadId, encode = (value) => value } = {}) => {
  if (!hasSecretRef(input)) return { ok: true, value: input, used: 0, values: [] };
  const now = Date.now();
  let used = 0;
  const values = [];
  let missing = null;
  const value = mapStringsDeep(input, (text) =>
    text.replace(new RegExp(SECRET_REF_PATTERN.source, 'g'), (ref) => {
      const entry = secretRefs.get(ref);
      if (!entry || entry.expiresAt <= now || !threadId || entry.threadId !== threadId) {
        missing ??= ref;
        return ref;
      }
      used += 1;
      if (!values.includes(entry.value)) values.push(entry.value);
      return encode(entry.value);
    })
  );
  if (missing) {
    return {
      ok: false,
      text: `The secret ref ${missing} is unknown, expired or from another thread. Ask the user again with request_secret (delivery "ref").`,
    };
  }
  return { ok: true, value, used, values };
};

// --- Scrubbing saved values from agent events ---------------------------------------------

const redactString = (text, values) => {
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(SECRET_REDACTED);
  }
  return out;
};

// Each value as it appears raw and inside a JSON string (a snapshot or a
// tool's JSON output escapes quotes, backslashes and control characters).
const valueForms = (value) => {
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped === value ? [value] : [value, escaped];
};

/**
 * `payload` with every saved secret value replaced by SECRET_REDACTED, raw or
 * JSON-escaped; the same object when nothing matched (and at no cost while
 * none is saved). Saved values shorter than SECRET_REDACT_MIN_CHARS are left
 * alone, except `alsoValues`: the secrets a call was just handed (any length).
 */
export const redactSecrets = (payload, { alsoValues = [] } = {}) => {
  if (savedSecretValues.size === 0 && alsoValues.length === 0) return payload;
  const now = Date.now();
  const forms = new Set();
  for (const [key, entry] of savedSecretValues) {
    if (entry.expiresAt <= now) savedSecretValues.delete(key);
    else if (entry.value.length >= SECRET_REDACT_MIN_CHARS) for (const form of valueForms(entry.value)) forms.add(form);
  }
  for (const value of alsoValues) {
    if (typeof value === 'string' && value) for (const form of valueForms(value)) forms.add(form);
  }
  if (forms.size === 0) return payload;
  // Longest first, so a value containing another is replaced whole.
  const values = [...forms].sort((a, b) => b.length - a.length);
  return mapStringsDeep(payload, (text) => redactString(text, values));
};
