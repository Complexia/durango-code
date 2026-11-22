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

const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
const INVALID_THINKING_SIGNATURE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const DURATION_UNIT_MS = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, 'μs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };

const SESSION_ID = /^[\w-]+$/;

export const antigravityConversationsDir = () =>
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');

const sessionDatabasePath = (sessionId) =>
  typeof sessionId === 'string' && SESSION_ID.test(sessionId)
    ? path.join(antigravityConversationsDir(), `${sessionId}.db`)
    : null;

let sqliteModule;
const openReadOnly = async (file) => {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = await import('node:sqlite');
    } catch {
      sqliteModule = null;
    }
  }
  if (!sqliteModule || !file || !fs.existsSync(file)) return null;
  let database = null;
  try {
    database = new sqliteModule.DatabaseSync(file, { readOnly: true });
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
  const database = await openReadOnly(sessionDatabasePath(sessionId));
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
export const antigravityConversationWork = async (sessionId, cursor = -1) => {
  const database = await openReadOnly(sessionDatabasePath(sessionId));
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

/**
 * The turn's failure from its error step's text: `{ message, brokenSession }`,
 * or null when the text shows no error. `brokenSession` means every later
 * prompt to this native session would fail the same way.
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
      message: `You have reached your Antigravity quota for this period.${resetSuffix(resetAtFrom(value, now))} Check Settings → Usage → Limits.`,
      brokenSession: false,
    };
  }
  if (INVALID_THINKING_SIGNATURE.test(value)) {
    return {
      message:
        "Antigravity's saved conversation can no longer be sent to the model. Send your message again: Durango Code starts a fresh Antigravity session for it.",
      brokenSession: true,
    };
  }
  if (!apiError) return { message: 'Antigravity stopped this turn because of an error.', brokenSession: false };
  const [, httpStatus, rawMessage, status] = apiError;
  const message = String(rawMessage || '').trim();
  const rateLimited = httpStatus === '429' || status === 'RESOURCE_EXHAUSTED';
  if (rateLimited) {
    return {
      message: `Antigravity is rate limited: ${message || status}.${resetSuffix(resetAtFrom(value, now))}`,
      brokenSession: false,
    };
  }
  if (httpStatus === '404' && !reachedModel) {
    return { message: `Antigravity can't use this model: ${message || status}. Pick another Antigravity model.`, brokenSession: false };
  }
  return { message: `Antigravity: ${message || status} (${status}, HTTP ${httpStatus}).`, brokenSession: false };
};

/** Reads the steps after `cursor`; null when the turn ended cleanly. */
export const antigravityTurnFailure = async (sessionId, cursor, stopReason) => {
  const database = await openReadOnly(sessionDatabasePath(sessionId));
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
