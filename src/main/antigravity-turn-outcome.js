import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// agy reports an upstream API failure (quota, rate limit, a model the plan
// lacks, a 5xx) as a chat message and a clean `end_turn`. Its per-session
// database ends that turn with an error step, so after the prompt resolves
// the driver reads the steps the prompt added, read-only, and fails the turn
// when the last one is an error. Same approach and patterns as T3 Code's
// apps/server/src/provider/acp/AntigravityTurnOutcome.ts. Verified on agy
// 1.5.14: ~/.gemini/antigravity-cli/conversations/<sessionId>.db, table
// `steps (idx, step_type, step_payload, …)`.

const ERROR_STEP_TYPE = 17; // CORTEX_STEP_TYPE_ERROR_MESSAGE
const PLANNER_RESPONSE_STEP_TYPE = 15; // the model answered within this turn
const PAYLOAD_BYTES = 16384;

const API_ERROR = /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s;
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
const INVALID_THINKING_SIGNATURE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const DURATION_UNIT_MS = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, 'μs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };
const TRANSIENT_STATUSES = new Set(['UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED', 'ABORTED']);

const SESSION_ID = /^[\w-]+$/;

export const antigravityConversationsDir = () =>
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');

const isSafeSegment = (segment) =>
  typeof segment === 'string' &&
  segment.length > 0 &&
  segment !== '.' &&
  segment !== '..' &&
  !segment.includes('/') &&
  !segment.includes('\\') &&
  !segment.includes('\0');

// Walks every managed component under `os.homedir()` using lstat + realpath so
// a symlinked `.gemini`, `antigravity-cli`, `conversations`, or `<id>.db` is
// never followed. `os.homedir()` itself is canonicalized first so temp homes
// under macOS `/var/folders` (`/var` -> `/private/var`) remain valid.
const resolveSafeSessionDb = (sessionId) => {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  let realHome;
  try {
    realHome = fs.realpathSync(os.homedir());
  } catch {
    return null;
  }
  const segments = ['.gemini', 'antigravity-cli', 'conversations', `${sessionId}.db`];
  let current = realHome;
  let stat = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!isSafeSegment(segment)) return null;
    current = path.join(current, segment);
    try {
      stat = fs.lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return null;
    const isLeaf = index === segments.length - 1;
    if (isLeaf ? !stat.isFile() : !stat.isDirectory()) return null;
  }
  let realTarget;
  try {
    realTarget = fs.realpathSync(current);
  } catch {
    return null;
  }
  if (realTarget !== current) return null;
  return { path: realTarget, stat };
};

const matchesDbIdentity = (stat, identity) => {
  if (!identity) return true;
  if (typeof identity !== 'object') return false;
  return stat.dev === identity.dev && stat.ino === identity.ino;
};

/**
 * Snapshots the session DB's filesystem identity (`dev`, `ino`) after
 * symlink-safe validation, or null if the DB does not exist or fails checks.
 */
export const antigravitySnapshotDbIdentity = (sessionId) => {
  const resolved = resolveSafeSessionDb(sessionId);
  if (!resolved) return null;
  return { dev: resolved.stat.dev, ino: resolved.stat.ino };
};

let sqliteModule;
const openReadOnly = async (sessionId, identity = null) => {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = await import('node:sqlite');
    } catch {
      sqliteModule = null;
    }
  }
  if (!sqliteModule) return null;
  const resolved = resolveSafeSessionDb(sessionId);
  if (!resolved || !matchesDbIdentity(resolved.stat, identity)) return null;
  let database = null;
  try {
    database = new sqliteModule.DatabaseSync(resolved.path, { readOnly: true });
    // Re-verify after opening to narrow TOCTOU replacement windows.
    const afterStat = fs.lstatSync(resolved.path);
    if (
      afterStat.isSymbolicLink() ||
      !afterStat.isFile() ||
      afterStat.dev !== resolved.stat.dev ||
      afterStat.ino !== resolved.stat.ino ||
      !matchesDbIdentity(afterStat, identity)
    ) {
      database.close();
      return null;
    }
    database.exec('PRAGMA busy_timeout = 100');
    const hasSteps = database
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
      .get();
    if (!hasSteps) {
      database.close();
      return null;
    }
    return database;
  } catch {
    try {
      database?.close();
    } catch {}
    return null;
  }
};

/** The session's last step index before a prompt (-1: none yet, or no database). */
export const antigravityStepCursor = async (sessionId) => {
  const database = await openReadOnly(sessionId);
  if (!database) return -1;
  try {
    const row = database.prepare('SELECT max(idx) AS idx FROM steps').get();
    return typeof row?.idx === 'number' ? row.idx : -1;
  } catch {
    return -1;
  } finally {
    database.close();
  }
};

// agy's CortexStepStatus (numbers from agy 1.5.14's protobuf descriptor).
// agy updates a step's status in place: a backgrounded command's step stays
// RUNNING until the command exits, and a step that needs a person (an
// approval nobody can give) stays WAITING.
const ACTIVE_STEP_STATUSES = [
  1, // PENDING
  2, // RUNNING
  11, // QUEUED
];
const GENERATING_STEP_STATUS = 8;
const WAITING_STEP_STATUS = 9;

/**
 * What agy still has in flight in a conversation, from its own step
 * statuses: counts of the steps after `cursor` that are running (commands,
 * tools), generating (a model step) or waiting on a person. null when the
 * database can't be read. A cursor taken when the process started leaves out
 * steps an earlier, killed process left RUNNING.
 */
export const antigravityConversationWork = async (sessionId, cursor = -1, identity = null) => {
  const database = await openReadOnly(sessionId, identity);
  if (!database) return null;
  try {
    const row = database
      .prepare(
        `SELECT
           coalesce(sum(status IN (${ACTIVE_STEP_STATUSES.join(', ')})), 0) AS running,
           coalesce(sum(status = ?), 0) AS generating,
           coalesce(sum(status = ?), 0) AS waiting
         FROM steps WHERE idx > ?`
      )
      .get(GENERATING_STEP_STATUS, WAITING_STEP_STATUS, cursor);
    return {
      running: Number(row?.running ?? 0),
      generating: Number(row?.generating ?? 0),
      waiting: Number(row?.waiting ?? 0),
    };
  } catch {
    return null;
  } finally {
    database.close();
  }
};

const resetAtFrom = (text, now) => {
  const stamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (stamp) {
    const time = Date.parse(stamp);
    if (Number.isFinite(time)) return time;
  }
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (!delay) return null;
  let ms = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) ms += Number(amount) * DURATION_UNIT_MS[unit];
  return ms > 0 ? now + ms : null;
};

const resetSuffix = (resetAt) =>
  resetAt
    ? ` It resets ${new Date(resetAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
    : '';

const cleanStatus = (rawStatus) => String(rawStatus || '').replace(/[\x00-\x1f].*$/, '').trim();

/**
 * The turn's failure from its error step's text:
 * `{ message, brokenSession, retryable, resumeWith? }`, or null when the text
 * shows no error. `brokenSession` means every later prompt to this native
 * session would fail the same way.
 */
export const antigravityFailureFromErrorText = (text, { stopReason, reachedModel = false, now = Date.now() } = {}) => {
  const value = String(text ?? '');
  if (!value && stopReason !== 'refusal') return null;
  const apiError = API_ERROR.exec(value) ?? (() => {
    const match = STATUS_ERROR.exec(value);
    return match ? [match[0], match[2], match[3], match[1]] : null;
  })();
  if (stopReason === 'refusal' || QUOTA_EXHAUSTED.test(value)) {
    return {
      message: `You have reached your Antigravity quota for this period.${resetSuffix(resetAtFrom(value, now))} Check Settings → Usage.`,
      brokenSession: false,
      retryable: false,
    };
  }
  if (INVALID_THINKING_SIGNATURE.test(value)) {
    return {
      message:
        "Antigravity's saved conversation can no longer be sent to the model. Send your message again: Durango Code starts a fresh Antigravity session for it.",
      brokenSession: true,
      retryable: false,
    };
  }
  if (!apiError) {
    return {
      message: 'Antigravity stopped this turn because of an error.',
      brokenSession: false,
      retryable: false,
    };
  }
  const [, httpStatus, rawMessage, rawStatus] = apiError;
  const message = String(rawMessage || '').trim();
  const status = cleanStatus(rawStatus);
  const rateLimited = httpStatus === '429' || status === 'RESOURCE_EXHAUSTED';
  if (rateLimited) {
    return {
      message: `Antigravity is rate limited: ${message || status}.${resetSuffix(resetAtFrom(value, now))}`,
      brokenSession: false,
      retryable: false,
    };
  }
  if (httpStatus === '404' && !reachedModel) {
    return {
      message: `Antigravity can't use this model: ${message || status}. Pick another Antigravity model.`,
      brokenSession: false,
      retryable: false,
    };
  }
  if (httpStatus === '404' && reachedModel) {
    return {
      message: `Antigravity: ${message || status} (${status}, HTTP 404).`,
      brokenSession: false,
      retryable: true,
      resumeWith: 'continue',
    };
  }
  const numericStatus = Number(httpStatus);
  const retryable =
    numericStatus === 408 ||
    (numericStatus >= 500 && numericStatus < 600) ||
    TRANSIENT_STATUSES.has(status);
  return {
    message: `Antigravity: ${message || status} (${status}, HTTP ${httpStatus}).`,
    brokenSession: false,
    retryable,
  };
};

/** Reads the steps after `cursor`; null when the turn ended cleanly. */
export const antigravityTurnFailure = async (sessionId, cursor, stopReason, identity = null) => {
  const database = await openReadOnly(sessionId, identity);
  if (!database) return stopReason === 'refusal' ? antigravityFailureFromErrorText('', { stopReason }) : null;
  try {
    const last = database
      .prepare(
        'SELECT step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1'
      )
      .get(PAYLOAD_BYTES, cursor);
    const reachedModel = Boolean(
      database.prepare('SELECT 1 AS ok FROM steps WHERE idx > ? AND step_type = ? LIMIT 1').get(cursor, PLANNER_RESPONSE_STEP_TYPE)
    );
    const errorText =
      last?.type === ERROR_STEP_TYPE && last.payload
        ? new TextDecoder().decode(last.payload instanceof Uint8Array ? last.payload : Buffer.from(last.payload))
        : null;
    if (errorText === null && stopReason !== 'refusal') return null;
    return antigravityFailureFromErrorText(errorText ?? '', { stopReason, reachedModel });
  } catch {
    return null;
  } finally {
    database.close();
  }
};
