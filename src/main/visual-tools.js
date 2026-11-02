import crypto from 'node:crypto';

// Inline HTML visuals on Durango Code's built-in `orion` MCP server
// (show_html): an agent illustrates an answer (a chart, diagram, comparison,
// mockup, step-through explainer) with a small self-contained HTML page that
// the transcript renders in place, in a sandboxed frame, where the call ran.
//
// The page joins the calling run's turn as an ordinary activity event
// (`emitAgentEvent`, keyed by the run id, so it lands on that run's reply and
// reaches remote-control viewers too) carrying the HTML; the transcript shows
// it as its own block between the text around it (src/app/HtmlVisual.tsx).
// The frame is `sandbox="allow-scripts"` with a CSP that blocks all network
// (src/app/visualDocument.ts), and the main window refuses any navigation of
// a visual frame (`guardVisualFrames`, main.js), so the tool is
// safe in every access mode and needs no approval.
//
// Claude runs register the tool on the in-process SDK server
// (claude-driver.js); every other provider reaches it through the stdio
// bridge shim (mcp-bridge-shim.cjs → mcp-bridge.js). The shim duplicates the
// description and schema below; test-durango-tools.mjs keeps them in sync.

export const VISUAL_TOOL_NAMES = Object.freeze(['show_html']);

/** Upper bound on one page; keeps thread files and IPC small. */
export const VISUAL_MAX_HTML_CHARS = 200_000;
export const VISUAL_MAX_TITLE_CHARS = 120;
export const VISUAL_MIN_HEIGHT = 80;
export const VISUAL_MAX_HEIGHT = 1600;

export const VISUAL_TOOL_DESCRIPTIONS = Object.freeze({
  show_html:
    'Show a small self-contained HTML page inline in this thread, where you call it, so you can illustrate an answer instead of only describing it: a chart of numbers you gathered, an architecture or flow diagram, a before/after or option comparison, a UI mockup, a timeline, an annotated walkthrough, a small interactive explainer. Use it when a picture makes the answer clearer than prose or a code block; plain text for short answers. It is not for files the user asked you to build (write those to disk) and not for previewing their app (use the browser). The page renders in a sandbox at the width of the reply: inline <style> and <script> only, no network (external scripts, fonts, images and fetch are blocked; use inline SVG, canvas or data: URIs), no storage, links do nothing. Leave html and body without a background, border or outer padding so it sits on the thread, and let content set the height (no vh units or height:100% on html/body); give charts a fixed pixel height. Use the theme CSS variables rather than fixed colors: --background, --foreground, --muted-foreground, --card, --border, --primary, --success, --warning, --danger, --viz-1 to --viz-8 (categorical chart colors), --radius, --font-sans, --font-mono (the page is dark). Keep it under about 60 KB. Do not restate what the page shows in your reply; say the takeaway in a sentence and carry on.',
});

export const VISUAL_TOOL_INPUT_SCHEMAS = Object.freeze({
  show_html: {
    type: 'object',
    properties: {
      html: {
        type: 'string',
        description: 'The page: an HTML fragment or a complete document, with inline <style> and <script>.',
      },
      title: {
        type: 'string',
        description: 'Short title for the visual, e.g. "Request flow" (used for accessibility and the fullscreen header)',
      },
      height: {
        type: 'integer',
        minimum: VISUAL_MIN_HEIGHT,
        maximum: VISUAL_MAX_HEIGHT,
        description: `Fixed frame height in CSS pixels (${VISUAL_MIN_HEIGHT}-${VISUAL_MAX_HEIGHT}). Omit to fit the content.`,
      },
    },
    required: ['html', 'title'],
    additionalProperties: false,
  },
});

const unavailable =
  'Durango Code could not show the visual: its window is no longer available. Describe it in your reply instead.';
const noTurn =
  'Durango Code could not show the visual: no turn of this thread is running. Describe it in your reply instead.';

/** A visual's document: about:srcdoc, with or without a fragment. */
export const isVisualDocumentUrl = (url) => typeof url === 'string' && /^about:srcdoc(?:#|$)/.test(url);

/**
 * Whether the main window must refuse a frame navigation: a sub-frame that
 * shows a visual navigating anywhere but its own document (location =, a
 * link whose click handler was removed, a refresh). Blocked before the
 * request starts, so a visual cannot send data out by navigating itself.
 *
 * A frame is a visual if it ever loaded about:srcdoc (`knownVisualFrame`,
 * tracked by frame id for the frame's lifetime), or if the navigating frame
 * or its initiator is about:srcdoc. Electron 42 reports the frame's url as ""
 * here and the initiator as about:srcdoc, or about:srcdoc#x after a fragment
 * change (which fires no will-frame-navigate of its own).
 */
export const shouldBlockVisualFrameNavigation = ({ isMainFrame, url, frameUrl, initiatorUrl, knownVisualFrame = false }) =>
  !isMainFrame &&
  !isVisualDocumentUrl(url) &&
  (knownVisualFrame || isVisualDocumentUrl(frameUrl) || isVisualDocumentUrl(initiatorUrl));

/**
 * Installs the visual navigation guard on a window's webContents (main.js).
 * `webFrameMain` is Electron's, passed in so this module stays importable
 * without Electron. Returns the set of known visual frame ids (for tests).
 */
export const guardVisualFrames = (webContents, webFrameMain) => {
  const visualFrames = new Set();
  // The first load of a visual's srcdoc fires no will-frame-navigate; record
  // the frame once it commits.
  webContents.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame, processId, routingId) => {
    if (isMainFrame || !isVisualDocumentUrl(url)) return;
    const id = webFrameMain.fromId(processId, routingId)?.frameTreeNodeId;
    if (typeof id === 'number') visualFrames.add(id);
  });
  webContents.on('will-frame-navigate', (details) => {
    const id = details.frame?.frameTreeNodeId;
    if (
      shouldBlockVisualFrameNavigation({
        isMainFrame: details.isMainFrame,
        url: details.url,
        frameUrl: details.frame?.url,
        initiatorUrl: details.initiator?.url,
        knownVisualFrame: typeof id === 'number' && visualFrames.has(id),
      })
    ) {
      details.preventDefault();
    }
  });
  return visualFrames;
};

/**
 * Checks show_html arguments. Returns `{ ok: true, visual }` or
 * `{ ok: false, text }` with a message the agent can act on.
 */
export const validateVisualArgs = (args) => {
  const html = typeof args?.html === 'string' ? args.html.trim() : '';
  if (!html) return { ok: false, text: 'show_html requires a non-empty string `html` argument.' };
  if (html.length > VISUAL_MAX_HTML_CHARS) {
    return {
      ok: false,
      text: `The page is ${html.length} characters; keep it under ${VISUAL_MAX_HTML_CHARS}. Generate data in script instead of inlining it, and drop embedded images.`,
    };
  }
  const title = typeof args?.title === 'string' ? args.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) return { ok: false, text: 'show_html requires a short string `title` argument.' };
  if (args?.height !== undefined && (typeof args.height !== 'number' || !Number.isFinite(args.height))) {
    return { ok: false, text: '`height` must be a number of CSS pixels; leave it out to fit the content.' };
  }
  const height =
    typeof args?.height === 'number'
      ? Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.round(args.height)))
      : undefined;
  return {
    ok: true,
    visual: {
      html,
      title: title.slice(0, VISUAL_MAX_TITLE_CHARS),
      ...(height !== undefined ? { height } : {}),
    },
  };
};

/**
 * Runs one visual tool for run `runId` of thread `threadId`. Resolves to
 * `{ ok, text }`, never throws. `emitEvent` defaults to events.js's
 * emitAgentEvent (injected by tests).
 */
export const runVisualTool = async (name, args, { getSender, threadId, runId, emitEvent }) => {
  if (name !== 'show_html') return { ok: false, text: `Unknown tool: ${name}` };
  if (!threadId) return { ok: false, text: 'This agent run is not attached to a Durango Code thread.' };
  const checked = validateVisualArgs(args);
  if (!checked.ok) return checked;
  if (!runId) return { ok: false, text: noTurn };
  const sender = getSender?.();
  if (!sender || sender.isDestroyed?.()) return { ok: false, text: unavailable };
  const emit = emitEvent ?? (await import('./events.js')).emitAgentEvent;
  const id = `vis_${crypto.randomUUID().slice(0, 8)}`;
  try {
    emit(sender, {
      runId,
      threadId,
      type: 'activity',
      activity: {
        key: `visual:${id}`,
        type: 'tool',
        kind: 'visual',
        title: checked.visual.title,
        status: 'done',
        visual: checked.visual,
      },
    });
  } catch {
    return { ok: false, text: unavailable };
  }
  return {
    ok: true,
    text: `Shown inline in the thread as "${checked.visual.title}". The user sees it where you called the tool; do not repeat its contents in text. To change it, call show_html again with the complete updated page.`,
  };
};
