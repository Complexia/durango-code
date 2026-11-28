import { createBotSecretKeys } from './bot-secret-keys.js';

// "Needs you" requests of bot-started threads in their bot's chat. The
// renderer (app/botThreadRequests.ts) hands over what this machine's
// bot-started threads wait on the person for, whenever that changes and every
// few seconds while anything waits; this sends it to Durango as the machine's
// whole set (so a bot's chat shows the same cards and the bot list highlights
// the bot) and gets back the answers the person gave in a bot's chat on
// another device. A secret's value comes back sealed to a key only this
// process holds: it is opened and handed to the waiting request here, and
// never reaches the renderer, the bot or any transcript. Done, Reply and
// Dismiss go back to the renderer, which presses that card's button.

const ANSWER_MEMORY = 200;

/**
 * deps:
 * - client: durango-client (syncBotThreadRequests)
 * - getMachineId(), getMachineName(): this machine's bot identity on Durango
 * - signedOut(): true when bots run locally here (signed out of Durango)
 * - answerSecretRequest({ threadId, id, answer }): secret-requests.js
 * - log(...)
 */
export const createBotThreadRequestsBridge = ({
  client,
  getMachineId,
  getMachineName = async () => null,
  signedOut = async () => false,
  answerSecretRequest,
  log = (...args) => console.warn('[durango bots]', ...args),
}) => {
  const keys = createBotSecretKeys();
  // Answers already applied here (request id + when it was given): a sync
  // that raced the apply gets it again.
  const applied = new Set();
  // Secret answers that couldn't be applied, reported on the next sync.
  const failed = new Map();
  const remember = (key) => {
    applied.add(key);
    while (applied.size > ANSWER_MEMORY) applied.delete(applied.values().next().value);
  };

  /** → 'ended' when the request was gone already (its card should go too). */
  const applySecret = async (answer) => {
    const key = `${answer.requestId}\n${answer.at}`;
    if (applied.has(key)) return null;
    remember(key);
    const threadId = answer.actionThreadId || answer.threadId;
    let result;
    try {
      if (answer.op === 'decline') {
        result = await answerSecretRequest({ threadId, id: answer.requestId, answer: { type: 'decline' } });
      } else if (answer.op === 'save' && typeof answer.sealed === 'string') {
        const value = keys.open(answer.requestId, answer.sealed);
        result = await answerSecretRequest({ threadId, id: answer.requestId, answer: { type: 'save', value } });
        // Used: nothing else may be opened with it.
        if (result?.ok || result?.ended) keys.spend(answer.requestId);
      } else {
        result = { ok: false, error: 'A secret request takes a value or Decline.' };
      }
    } catch (error) {
      result = { ok: false, error: error?.message ?? String(error) };
    }
    if (result?.ended) return 'ended';
    if (!result?.ok) {
      failed.set(`${answer.threadId}\n${answer.requestId}`, {
        threadId: answer.threadId,
        requestId: answer.requestId,
        at: answer.at,
        error: String(result?.error ?? 'It could not be saved.').slice(0, 300),
      });
    }
    return null;
  };

  const syncSet = async (threads, reported, resolved) => {
    const machineId = await Promise.resolve(getMachineId()).catch(() => null);
    if (!machineId) return { ok: false, code: 'no_machine' };
    const machineName = await Promise.resolve(getMachineName()).catch(() => null);
    return {
      ok: true,
      result: await client.syncBotThreadRequests({
        machineId,
        ...(machineName ? { machineName } : {}),
        threads,
        ...(reported.length ? { failed: reported.slice(0, 50) } : {}),
        ...(resolved.length ? { resolved: resolved.slice(0, 50) } : {}),
      }),
    };
  };

  return {
    /**
     * `{ threads: [{ threadId, owner, threadTitle?, projectName?, requests: [{ requestId, kind, text, … }] }], failed?, resolved? }`
     * → `{ ok, answers }` (Done / Reply / Dismiss for the renderer to press),
     * or `{ ok: false, code }` (signed out, offline).
     */
    async sync(input = {}) {
      if (await Promise.resolve(signedOut()).catch(() => true)) return { ok: false, code: 'local' };
      const secretIds = [];
      const threads = (Array.isArray(input.threads) ? input.threads : []).map((thread) => ({
        ...thread,
        requests: (Array.isArray(thread?.requests) ? thread.requests : []).map((request) => {
          if (request?.kind !== 'secret') return request;
          secretIds.push(request.requestId);
          return { ...request, secretKey: keys.publicKeyFor(request.requestId) };
        }),
      }));
      keys.keepOnly(secretIds);
      const reported = [...(Array.isArray(input.failed) ? input.failed : []), ...failed.values()];
      const resolved = Array.isArray(input.resolved) ? input.resolved : [];
      let result;
      try {
        const synced = await syncSet(threads, reported, resolved);
        if (!synced.ok) return synced;
        result = synced.result;
      } catch (error) {
        return { ok: false, code: error?.code ?? 'failed', error: error?.message ?? String(error) };
      }
      failed.clear();
      const answers = [];
      const ended = [];
      for (const answer of result.answers ?? []) {
        if (!answer || typeof answer.requestId !== 'string' || typeof answer.threadId !== 'string') continue;
        if (answer.kind === 'secret') {
          const outcome = await applySecret(answer).catch((error) => {
            log('a secret answer from a bot chat failed:', error?.message ?? error);
            return null;
          });
          // The request had ended (its run stopped): the renderer drops its stale card.
          if (outcome === 'ended') ended.push({ threadId: answer.actionThreadId || answer.threadId, requestId: answer.requestId });
          continue;
        }
        if (answer.op !== 'done' && answer.op !== 'reply' && answer.op !== 'dismiss') continue;
        answers.push({
          threadId: answer.threadId,
          actionThreadId: typeof answer.actionThreadId === 'string' ? answer.actionThreadId : answer.threadId,
          requestId: answer.requestId,
          op: answer.op,
          ...(typeof answer.reply === 'string' ? { reply: answer.reply } : {}),
          at: Number(answer.at) || 0,
        });
      }
      return { ok: true, answers, ...(ended.length ? { ended } : {}) };
    },
    /** Before signing out: Durango drops this machine's cards (best effort; signed out, nothing to clear). */
    async clear() {
      if (await Promise.resolve(signedOut()).catch(() => true)) return { ok: false };
      keys.keepOnly([]);
      const synced = await syncSet([], [], []);
      return { ok: synced.ok };
    },
    /** The person answers from this computer's bot chat a request whose thread isn't here: `{ requestId, op, reply?, sealed? }`. */
    async answer(input = {}) {
      if (await Promise.resolve(signedOut()).catch(() => true)) return { ok: false, error: 'Sign in to Durango to answer it here.' };
      const op = String(input.op ?? '');
      if (!['done', 'reply', 'dismiss', 'save', 'decline'].includes(op)) return { ok: false, error: 'Unknown answer.' };
      try {
        return await client.answerBotThreadRequest({
          requestId: String(input.requestId ?? ''),
          op,
          ...(op === 'reply' ? { reply: String(input.reply ?? '').slice(0, 8_000) } : {}),
          ...(op === 'save' ? { sealed: String(input.sealed ?? '') } : {}),
        });
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
  };
};
