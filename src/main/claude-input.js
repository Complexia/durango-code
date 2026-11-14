import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { emitAgentEvent } from './events.js';
import { snapShotOutlinePromptText } from './snapshot-format.js';
import { approvalView } from './approval-explainer.js';

// Preserve the original files for Read/crop tools while also delivering vision
// inputs on the user turn, as Claude Code does for pasted images and PDFs.
export const claudeUserContent = async (text, attachments = []) => {
  const content = [{ type: 'text', text }];
  const seen = new Set();
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const file = attachment?.path;
    const mime = attachment?.mimeType;
    if (typeof file !== 'string' || !path.isAbsolute(file) || seen.has(file)) continue;
    // A SnapShot's accessibility outline goes inline as framed, untrusted
    // text; the path in the prompt still points at the full file.
    if (attachment?.snapshot?.kind === 'accessibility') {
      seen.add(file);
      const outline = await fs.readFile(file, 'utf8').catch(() => null);
      if (outline !== null) content.push({ type: 'text', text: snapShotOutlinePromptText(attachment, outline) });
      continue;
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'].includes(mime)) continue;
    seen.add(file);
    // Do not silently lose an attachment when a file disappeared after upload.
    const data = (await fs.readFile(file)).toString('base64');
    content.push({
      type: mime === 'application/pdf' ? 'document' : 'image',
      source: { type: 'base64', media_type: mime, data },
    });
  }
  return content;
};

export const claudeNoticeActivity = (message) => {
  const titles = {
    model_refusal_fallback: 'Claude changed models', model_refusal_no_fallback: 'Claude could not continue',
    informational: 'Claude notice', notification: 'Claude notice', permission_denied: 'Permission denied',
    api_retry: 'Claude is retrying',
  };
  if (message?.type === 'system' && titles[message.subtype]) {
    const detail = message.content || message.text || message.message ||
      (message.subtype === 'api_retry' ? `Attempt ${message.attempt} of ${message.max_retries}; retrying in ${Math.ceil(message.retry_delay_ms / 1000)} seconds.` : '');
    return { key: message.uuid || message.key, type: 'tool', title: titles[message.subtype], detail, status: 'done' };
  }
  if (message?.type === 'rate_limit_event' && message.rate_limit_info?.status !== 'allowed') {
    const info = message.rate_limit_info;
    if (!info) return null;
    return {
      key: message.uuid, type: 'tool', title: info.status === 'rejected' ? 'Claude usage limit reached' : 'Claude usage limit approaching',
      detail: [info.rateLimitType, info.resetsAt ? `Resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : '', info.overageDisabledReason].filter(Boolean).join(' · '), status: 'done',
    };
  }
  return null;
};

// Requests belong to a live session and exact run. They survive renderer
// navigation, but Stop, interruption, and session replacement cancel them.
export const createClaudeInputRequests = (session) => {
  const pending = new Map();
  const notify = (runId) => {
    try {
      emitAgentEvent(session.sender, { runId, threadId: session.threadId, type: 'user-input' });
    } catch {
      // A closing window must not break SDK settlement. A reopened renderer
      // fetches pending requests from the live session again.
    }
  };
  const request = (questions, signal, resolveAnswer, cancelled, extra = {}, { agentId } = {}) => {
    const runId = session.activeTurns[0]?.runId ?? session.backgroundRunId;
    if (!runId || session.disposed || session.ended || signal?.aborted) return Promise.resolve(cancelled);
    // Opened while a steer waits: the steer is the reply, at once (the model
    // would otherwise sit on this card and never read it).
    if (!agentId) {
      const steerReply = session.takeSteerReply?.();
      if (steerReply) return Promise.resolve({ ...cancelled, message: steerReply });
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const settle = (value) => {
        if (!pending.delete(requestId)) return;
        signal?.removeEventListener('abort', abort);
        resolve(value);
        notify(runId);
      };
      // `reason` (a steer) replaces the denial's message: the model reads it
      // as the tool's result. Called bare as the signal's abort listener.
      const abort = (reason) =>
        settle(typeof reason === 'string' && reason ? { ...cancelled, message: reason } : cancelled);
      pending.set(requestId, {
        view: { providerId: 'claude', runId, requestId, threadId: session.threadId, questions, ...extra },
        mainLoop: !agentId,
        answer: (answers) => settle(resolveAnswer(answers)), abort,
      });
      signal?.addEventListener('abort', abort, { once: true });
      notify(runId);
    });
  };
  return {
    list: () => [...pending.values()].map(({ view }) => view),
    answer(runId, requestId, answers) {
      const entry = pending.get(requestId);
      if (!entry || entry.view.runId !== runId || session.disposed || session.ended) return false;
      for (const question of entry.view.questions) {
        const values = answers?.[question.id];
        if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value.trim())) return false;
        if (!question.multiSelect && values.length !== 1) return false;
        if (question.allowCustom === false && values.some((value) => !question.options.some((option) => option.label === value))) return false;
      }
      entry.answer(answers);
      return true;
    },
    cancelAll() { for (const entry of [...pending.values()]) entry.abort(); },
    /**
     * A steer while the main loop waits on a question or approval: decline
     * it with `message` (the user's new instruction) so the model reads it
     * now instead of after an answer that will never come. Subagents' cards
     * stay. True when the main loop got the message.
     */
    declineMainLoop(message) {
      const entries = [...pending.values()].filter((entry) => entry.mainLoop);
      for (const entry of entries) entry.abort(message);
      return entries.length > 0;
    },
    canUseTool(toolName, input, options = {}) {
      const cancelled = { behavior: 'deny', message: 'The user input request was cancelled.' };
      if (toolName === 'AskUserQuestion') {
        if (!Array.isArray(input.questions) || !input.questions.length || input.questions.some((q) => typeof q.question !== 'string' || !q.question)) return Promise.resolve(cancelled);
        const questions = input.questions.map((q, index) => ({
          id: String(index), header: q.header || 'Question', question: q.question,
          multiSelect: q.multiSelect === true,
          options: Array.isArray(q.options) ? q.options : [],
        }));
        return request(questions, options.signal, (answers) => ({
          behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(
            questions.map((q) => [q.question, answers[q.id].join(', ')])
          ) },
        }), cancelled, {}, { agentId: options.agentID });
      }
      // This callback is reached only after Claude Code's permission policy.
      // An unanswered approval must never become an implicit allow.
      return request([{
        id: 'permission', header: options.displayName || toolName,
        question: options.title || `Allow Claude to use ${toolName}?`, allowCustom: false,
        options: [{ label: 'Allow once', description: 'Approve this tool call only.' }, { label: 'Deny', description: 'Do not run this tool call.' }],
      }], options.signal, (answers) => answers.permission[0] === 'Allow once'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The user denied this tool call.' }, cancelled,
      {
        // `approval` drives the approval card; `detail` stays for controllers
        // (remote machines, older builds) that only know the generic card.
        approval: approvalView(toolName, input, options),
        detail: [options.description, options.decisionReason, JSON.stringify(input, null, 2)].filter(Boolean).join('\n\n'),
      }, { agentId: options.agentID });
    },
  };
};
