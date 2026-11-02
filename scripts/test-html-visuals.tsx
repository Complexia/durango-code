// Inline HTML visuals (show_html): the sandboxed frame document, the frame
// protocol, the tool's validation, and where visuals sit in a turn.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { activityLabel, buildAgentRunSegments } from '../src/app/activity';
import { ChatMessage } from '../src/app/chat';
import {
  buildVisualDocument,
  clampVisualHeight,
  normalizeVisualHtml,
  parseVisualMessage,
  resolveVisualTheme,
  sanitizeThemeVars,
  VISUAL_CSP,
  VISUAL_MESSAGE_SOURCE,
  VISUAL_SANDBOX,
} from '../src/app/visualDocument';
import { guardVisualFrames, isVisualDocumentUrl, runVisualTool, shouldBlockVisualFrameNavigation, validateVisualArgs, VISUAL_MAX_HTML_CHARS } from '../src/main/visual-tools.js';
import type { AgentActivity, Message } from '../src/store';

// --- The frame document ---------------------------------------------------------------------
assert.equal(VISUAL_SANDBOX, 'allow-scripts', 'never allow-same-origin: the page must not reach the app');
assert.match(VISUAL_CSP, /default-src 'none'/);
assert.match(VISUAL_CSP, /connect-src 'none'/);
const doc = buildVisualDocument('<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://x.test"><link rel="stylesheet" href="https://x.test/a.css"><base href="https://x.test/"></head><body><h1>Hi</h1></body></html>', {
  '--foreground': '#fff',
  '--evil': 'red;}</style><script>alert(1)</script>',
});
const head = doc.slice(0, doc.indexOf('</head>'));
assert.ok(head.indexOf('Content-Security-Policy') < head.indexOf('<style>'), 'the CSP comes before anything else');
assert.equal((doc.match(/http-equiv="refresh"/g) ?? []).length, 0, 'meta refresh is stripped');
assert.doesNotMatch(doc, /<link|<base/, 'link and base are stripped');
assert.match(doc, /<h1>Hi<\/h1>/);
assert.match(doc, /--foreground:#fff/);
assert.doesNotMatch(doc, /alert\(1\)/, 'theme values cannot escape their declaration');
assert.equal(normalizeVisualHtml('﻿<div>x</div>'), '<div>x</div>');
assert.deepEqual(sanitizeThemeVars({ '--a': 'rgb(1 2 3 / 50%)', '--b': 'url("x")', notvar: 'red' }), { '--a': 'rgb(1 2 3 / 50%)' });
const theme = resolveVisualTheme((name) => (name === '--text-primary' ? ' #eee ' : ''));
assert.equal(theme['--foreground'], '#eee', 'reads the app variable');
assert.equal(theme['--card'], '#1d1d21', 'falls back when the app variable is missing');
assert.equal(theme['--viz-1'], '#3987e5', 'chart palette matches durango.sh chat (dark)');

// --- Frame -> app messages ------------------------------------------------------------------
const msg = (fields: Record<string, unknown>) => ({ source: VISUAL_MESSAGE_SOURCE, ...fields });
assert.deepEqual(parseVisualMessage(msg({ type: 'resize', height: 300 })), { type: 'resize', height: 300 });
assert.equal(parseVisualMessage(msg({ type: 'resize', height: -1 })), null);
assert.equal(parseVisualMessage({ type: 'resize', height: 300 }), null, 'untagged messages are ignored');
assert.deepEqual(parseVisualMessage(msg({ type: 'link', href: 'https://example.com/a' })), { type: 'link', href: 'https://example.com/a' });
assert.equal(parseVisualMessage(msg({ type: 'link', href: 'file:///etc/passwd' })), null, 'only http(s) links open');
assert.equal(parseVisualMessage(msg({ type: 'link', href: 'javascript:alert(1)' })), null);
assert.deepEqual(parseVisualMessage(msg({ type: 'error', message: '  boom \n here ' })), { type: 'error', message: 'boom here' });
assert.equal(clampVisualHeight(50, 1000), 80);
assert.equal(clampVisualHeight(5000, 1000), 850, 'a fitted frame stays within the window');
assert.equal(clampVisualHeight(400, 1000), 400);

// --- The tool --------------------------------------------------------------------------------
assert.equal(validateVisualArgs({ html: ' ', title: 'x' }).ok, false);
assert.equal(validateVisualArgs({ html: '<p>x</p>' }).ok, false, 'title is required');
assert.equal(validateVisualArgs({ html: 'x'.repeat(VISUAL_MAX_HTML_CHARS + 1), title: 't' }).ok, false);
assert.equal(validateVisualArgs({ html: '<p>x</p>', title: 't', height: 'tall' }).ok, false);
const clamped = validateVisualArgs({ html: '<p>x</p>', title: '  Request\n flow ', height: 99999 });
assert.ok(clamped.ok);
assert.deepEqual(clamped.ok && clamped.visual, { html: '<p>x</p>', title: 'Request flow', height: 1600 });
const sender = { send: () => {}, isDestroyed: () => false };
const emitted: Array<{ sender: unknown; event: Record<string, any> }> = [];
const emitEvent = (target: unknown, event: Record<string, any>) => emitted.push({ sender: target, event });
const context = { getSender: () => sender, threadId: 'thread-1', runId: 'run-7', emitEvent };
const shown = await runVisualTool('show_html', { html: '<svg></svg>', title: 'Flow' }, context);
assert.equal(shown.ok, true);
assert.match(shown.text, /do not repeat/);
assert.equal(emitted.length, 1);
const { event } = emitted[0];
assert.equal(emitted[0].sender, sender);
assert.equal(event.type, 'activity', 'an ordinary activity event: same path as every step, remote control included');
assert.equal(event.runId, 'run-7', 'it lands on the calling run, not whichever reply is newest');
assert.equal(event.threadId, 'thread-1');
assert.match(event.activity.key, /^visual:vis_/);
assert.deepEqual(event.activity.visual, { html: '<svg></svg>', title: 'Flow' });
const noTurn = await runVisualTool('show_html', { html: '<p/>', title: 't' }, { ...context, runId: undefined });
assert.equal(noTurn.ok, false, 'no running turn: told to describe it instead');
assert.match(noTurn.text, /Describe it in your reply/);
assert.equal((await runVisualTool('show_html', { html: '<p/>', title: 't' }, { ...context, getSender: () => null })).ok, false, 'no window');
assert.equal((await runVisualTool('show_html', { html: '<p/>', title: 't' }, { ...context, threadId: '' })).ok, false);
assert.equal(emitted.length, 1, 'refused calls emit nothing');

// --- Visual frames never navigate --------------------------------------------------------------
assert.equal(shouldBlockVisualFrameNavigation({ isMainFrame: false, url: 'https://evil.test/?d=secret', frameUrl: 'about:srcdoc' }), true);
assert.equal(shouldBlockVisualFrameNavigation({ isMainFrame: false, url: 'data:text/html,x', frameUrl: 'about:srcdoc' }), true);
assert.equal(
  shouldBlockVisualFrameNavigation({ isMainFrame: false, url: 'https://evil.test/?d=secret', frameUrl: '', initiatorUrl: 'about:srcdoc' }),
  true,
  'what Electron 42 reports for location.replace in a visual'
);
assert.equal(shouldBlockVisualFrameNavigation({ isMainFrame: false, url: 'about:srcdoc', frameUrl: '', initiatorUrl: 'http://localhost:5173/' }), false, 'the app loads a visual');
assert.equal(
  shouldBlockVisualFrameNavigation({ isMainFrame: false, url: 'https://evil.test/', frameUrl: '', initiatorUrl: 'about:srcdoc#x' }),
  true,
  'a fragment change first does not hide the visual'
);
assert.equal(
  shouldBlockVisualFrameNavigation({ isMainFrame: false, url: 'https://evil.test/', frameUrl: '', initiatorUrl: undefined, knownVisualFrame: true }),
  true,
  'a frame that ever loaded a visual stays one'
);
assert.equal(isVisualDocumentUrl('about:srcdoc#a'), true);
assert.equal(isVisualDocumentUrl('about:srcdocx'), false);

// guardVisualFrames: records visual frames as they commit and refuses their navigations.
const handlers: Record<string, (...args: any[]) => void> = {};
const fakeContents = { on: (name: string, handler: (...args: any[]) => void) => { handlers[name] = handler; } };
const frames = new Map([['1:5', { frameTreeNodeId: 9 }], ['1:6', { frameTreeNodeId: 10 }]]);
const fakeFrameMain = { fromId: (pid: number, rid: number) => frames.get(`${pid}:${rid}`) };
const known = guardVisualFrames(fakeContents, fakeFrameMain);
handlers['did-frame-navigate']({}, 'about:srcdoc', 200, '', false, 1, 5);
handlers['did-frame-navigate']({}, 'file:///x.pdf', 200, '', false, 1, 6);
assert.deepEqual([...known], [9]);
let prevented = 0;
const navigate = (frame: unknown, url: string, initiator?: string) =>
  handlers['will-frame-navigate']({ isMainFrame: false, url, frame, initiator: initiator ? { url: initiator } : undefined, preventDefault: () => (prevented += 1) });
navigate({ frameTreeNodeId: 9, url: '' }, 'https://evil.test/');
assert.equal(prevented, 1, 'the visual frame is refused even with no initiator');
navigate({ frameTreeNodeId: 10, url: 'file:///x.pdf' }, 'file:///y.pdf', 'http://localhost:5173/');
assert.equal(prevented, 1, 'the PDF preview frame still navigates');
assert.equal(shouldBlockVisualFrameNavigation({ isMainFrame: false, url: 'about:srcdoc', frameUrl: 'about:blank' }), false, 'a new visual loads');
assert.equal(shouldBlockVisualFrameNavigation({ isMainFrame: false, url: 'about:srcdoc', frameUrl: '' }), false);
assert.equal(shouldBlockVisualFrameNavigation({ isMainFrame: false, url: 'file:///doc.pdf', frameUrl: 'about:blank' }), false, 'other frames (PDF preview) are untouched');
assert.equal(shouldBlockVisualFrameNavigation({ isMainFrame: true, url: 'https://x.test', frameUrl: 'about:srcdoc' }), false, 'the main frame has its own guard');

// --- In the turn ------------------------------------------------------------------------------
const step = (id: string, fields: Partial<AgentActivity>): AgentActivity => ({
  id,
  type: 'tool',
  title: 'Tool - Read',
  status: 'done',
  ts: '2026-11-02T05:00:00.000Z',
  ...fields,
});
const read = step('r1', { detail: 'src/a.ts', contentOffset: 10 });
const call = step('call', { title: 'Tool - mcp__orion__show_html', detail: '{"html":"<svg/>"}', contentOffset: 10 });
const visual = step('v1', { kind: 'visual', title: 'Flow', contentOffset: 10, visual: { html: '<svg></svg>', title: 'Flow' } });
const read2 = step('r2', { detail: 'src/b.ts', contentOffset: 10 });
assert.equal(activityLabel(call).text, 'Showed a visual');

const segments = buildAgentRunSegments('Looking...\n\nDone.', [read, call, visual, read2]);
assert.deepEqual(
  segments.map((segment) => segment.kind),
  ['text', 'activities', 'visual', 'activities', 'text'],
  'a visual stands on its own between the steps around it'
);

const done: Message = {
  id: 'run',
  role: 'agent',
  kind: 'agent-run',
  status: 'done',
  ts: '2026-11-02T05:00:00.000Z',
  startedAt: '2026-11-02T05:00:00.000Z',
  completedAt: '2026-11-02T05:01:00.000Z',
  content: 'Looking...\n\nDone.',
  activities: [read, call, visual, read2],
};
const foldedHtml = renderToStaticMarkup(<ChatMessage message={done} runRunning={false} />);
assert.match(foldedHtml, /data-testid="html-visual"/, 'the visual stays visible when the steps fold');
assert.doesNotMatch(foldedHtml, /Looking\.\.\./, 'the text before the steps folds away');
assert.match(foldedHtml, /Done\./);

const running: Message = { ...done, status: 'running', completedAt: undefined, content: 'Looking...', activities: [read, call, visual] };
const runningHtml = renderToStaticMarkup(<ChatMessage message={running} runRunning />);
assert.match(runningHtml, /data-testid="html-visual".*>Thinking</s, 'after a visual the agent is thinking');

console.log('html visual tests passed');
