import crypto from 'node:crypto';

// User actions on Durango Code's built-in `orion` MCP server
// (request_user_action, resolve_user_action): an agent that needs the user to
// do something outside the chat (sign in in the browser, approve an npm
// login, plug in a device) says so here instead of burying it in its reply.
// The renderer keeps the action on the thread, tints it as needing the user,
// wakes it from Snoozed and pins the action above the composer until it is
// resolved. The call never blocks: the agent keeps working meanwhile.
//
// Claude runs register the tools on the in-process SDK server
// (claude-driver.js); every other provider reaches them through the stdio
// bridge shim (mcp-bridge-shim.cjs → mcp-bridge.js). The shim duplicates the
// descriptions and schemas below; test-durango-tools.mjs keeps them in sync.

export const USER_ACTION_TOOL_NAMES = Object.freeze(['request_user_action', 'resolve_user_action']);

export const USER_ACTION_MAX_CHARS = 2_000;

export const USER_ACTION_TOOL_DESCRIPTIONS = Object.freeze({
  request_user_action:
    'Ask the user to do something only they can do outside this chat, such as signing in or authorizing in a browser window you opened (npm login, OAuth, a CLI device code), approving a prompt on their machine, or pasting a value you cannot get yourself. Durango Code marks the thread as needing the user, brings it back from Snoozed, and pins the action above the composer until it is resolved, so it does not get lost in your replies. It returns at once: keep working on anything that does not depend on it. Write the action as one clear instruction (what to do, where, and any code to enter). Call resolve_user_action with the returned action_id as soon as you see it is done. When the user marks it done in Durango Code, the action is cleared and you get a message starting with "Done:" that repeats it, so you need not ask them to tell you.',
  resolve_user_action:
    'Clear an action you asked the user for with request_user_action, once it is done (you saw it succeed, or the user said so) or no longer needed. Without action_id, clears every action pending on this thread.',
});

export const USER_ACTION_TOOL_INPUT_SCHEMAS = Object.freeze({
  request_user_action: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          'What the user should do, as one clear instruction, e.g. "Finish the npm login in the browser tab that opened (code ABCD-1234)."',
      },
      url: {
        type: 'string',
        description: 'Link the user should open for it, if any (shown as an Open button)',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  resolve_user_action: {
    type: 'object',
    properties: {
      action_id: {
        type: 'string',
        description: 'The action_id request_user_action returned; omit to clear every pending action on this thread',
      },
    },
    additionalProperties: false,
  },
});

const unavailable = 'Durango Code could not show this to the user: its window is no longer available. Ask in your reply instead.';

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

/**
 * Runs one user-action tool for the thread `threadId`. Resolves to
 * `{ ok, text }`, never throws.
 */
export const runUserActionTool = async (name, args, { getSender, threadId }) => {
  if (!threadId) return { ok: false, text: 'This agent run is not attached to a Durango Code thread.' };
  if (name === 'request_user_action') {
    const action = typeof args?.action === 'string' ? args.action.trim() : '';
    if (!action) return { ok: false, text: 'request_user_action requires a non-empty string `action` argument.' };
    if (action.length > USER_ACTION_MAX_CHARS) {
      return { ok: false, text: `Keep the action under ${USER_ACTION_MAX_CHARS} characters: one clear instruction.` };
    }
    if (args?.url !== undefined && !httpUrl(args.url)) {
      return { ok: false, text: '`url` must be an http(s) link; leave it out if there is none.' };
    }
    const id = `ua_${crypto.randomUUID().slice(0, 8)}`;
    const url = httpUrl(args?.url);
    if (!sendToRenderer(getSender, { type: 'request', threadId, id, action, ...(url ? { url } : {}) })) {
      return { ok: false, text: unavailable };
    }
    return {
      ok: true,
      text: `Shown to the user as action_id ${id}: the thread is marked as needing them and the action stays pinned above the composer. Keep working on whatever does not depend on it, and call resolve_user_action with action_id ${id} once it is done.`,
    };
  }
  if (name === 'resolve_user_action') {
    const id = typeof args?.action_id === 'string' && args.action_id.trim() ? args.action_id.trim() : undefined;
    if (!sendToRenderer(getSender, { type: 'resolve', threadId, ...(id ? { id } : {}) })) {
      return { ok: false, text: unavailable };
    }
    return { ok: true, text: id ? `Cleared action ${id}.` : 'Cleared every pending action on this thread.' };
  }
  return { ok: false, text: `Unknown tool: ${name}` };
};
