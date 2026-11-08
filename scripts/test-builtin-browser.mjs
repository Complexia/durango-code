// Built-in browser: URL policy, ownership, snapshot refs and format, settings
// migration, the tool definitions shared by Claude and the bridge shim, and
// an end-to-end run of the browser_* tools against real WebContentsViews in a
// hidden window, driven through runBrowserTool and through the bridge shim.
//
//   node scripts/run-electron-test.mjs scripts/test-builtin-browser.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, dialog } from 'electron';
import { z } from 'zod';

import {
  checkBrowserUrl,
  checkTabAccess,
  checkTabLimits,
  createRefState,
  beginRefGeneration,
  invalidateRefs,
  normalizeBrowserUrl,
  resolveRef,
  ownerKeyFor,
  MAX_TABS_PER_OWNER,
  MAX_TABS_TOTAL,
} from '../src/main/browser/policy.js';
import { buildSnapshot, clampSnapshotMaxChars } from '../src/main/browser/snapshot.js';
import { parseKeyCombo } from '../src/main/browser/actions.js';
import {
  BROWSER_TOOLS,
  BROWSER_TOOL_NAMES,
  READ_ONLY_BROWSER_TOOL_NAMES,
  browserModeFor,
  claudeBrowserSetting,
  builtinBrowserTips,
  hasBuiltinBrowser,
  looksLikeSignIn,
  signInHint,
  signedInBrowserFor,
  runBrowserTool,
  setBrowserManager,
} from '../src/main/browser-tools.js';
import { createBrowserManager } from '../src/main/browser/manager.js';
import { canRouteGuestDialogs } from '../src/main/browser/guest-dialogs.js';
import { moveHeldDownload, reserveDownloadPath } from '../src/main/browser/security.js';
import { claudeSdkOptionsForInput, createOrionMcpServer, CLAUDE_BROWSER_AGENT_ARG, claudeBrowserAgentHooks } from '../src/main/claude-driver.js';
import { commandForModel } from '../src/main/command-for-model.js';
import { codexBrowserOptionsForIntegration } from '../src/main/codex-browser-integration.js';
import { handleMcpBridgeConnection, mcpBridgeSessions } from '../src/main/mcp-bridge.js';
import { BROWSER_READ_TOOL_NAMES, isPreapprovedOrionTool } from '../src/main/thread-reader-routing.js';
import shimSource from '../src/mcp-bridge-shim.cjs?raw';

// BB_DEBUG=<file> traces each tool call there (stdout can be lost on a timeout).
const trace = (...parts) => {
  if (process.env.BB_DEBUG) appendFileSync(process.env.BB_DEBUG, `${parts.join(' ')}\n`);
};
// Electron emits 'ready' only after the main module finishes evaluating, so
// the body must not hold module evaluation with a top-level await.
const testRoot = path.join(os.tmpdir(), `orion-builtin-browser-${process.pid}`);
app.setPath('userData', path.join(testRoot, 'userData'));

const main = async () => {
try {
  await fs.mkdir(testRoot, { recursive: true });
  // ---- URL policy ---------------------------------------------------------------
  assert.equal(normalizeBrowserUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeBrowserUrl('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  assert.equal(normalizeBrowserUrl('example.com'), 'https://example.com');
  assert.equal(normalizeBrowserUrl(''), 'about:blank');
  assert.equal(normalizeBrowserUrl('/tmp/x.html'), 'file:///tmp/x.html');
  assert.equal(normalizeBrowserUrl('about:blank'), 'about:blank');
  assert.equal(checkBrowserUrl('https://example.com').ok, true);
  assert.equal(checkBrowserUrl('http://localhost:3000').ok, true);
  assert.equal(checkBrowserUrl('about:blank').ok, true);
  assert.equal(checkBrowserUrl('javascript:alert(1)').ok, false);
  assert.equal(checkBrowserUrl('chrome://settings').ok, false);
  assert.equal(checkBrowserUrl('devtools://devtools/bundled/inspector.html').ok, false);
  assert.equal(checkBrowserUrl('vscode://file/x').ok, false);
  assert.equal(checkBrowserUrl('data:text/html,hi').ok, false, 'top-level data: is blocked');
  assert.equal(checkBrowserUrl('data:text/html,hi', { topLevel: false }).ok, true, 'subframe data: is fine');
  assert.equal(checkBrowserUrl('file:///etc/passwd', { projectPath: '/Users/me/app' }).ok, false);
  assert.equal(checkBrowserUrl('file:///Users/me/app/index.html', { projectPath: '/Users/me/app' }).ok, true);
  assert.equal(checkBrowserUrl('file:///Users/me/app-evil/x.html', { projectPath: '/Users/me/app' }).ok, false, 'sibling prefix is outside');
  assert.equal(checkBrowserUrl('file:///Users/me/app/../x.html', { projectPath: '/Users/me/app' }).ok, false);
  assert.equal(checkBrowserUrl('file:///Users/me/app/index.html').ok, false, 'no project: no file:');
  assert.match(checkBrowserUrl('not a url').reason, /not a valid URL/);
  // Full access (or the user's own tabs): file: anywhere, data: and javascript: too.
  const full = { projectPath: '/Users/me/app', fullAccess: true };
  assert.equal(checkBrowserUrl('file:///etc/hosts', full).ok, true);
  assert.equal(checkBrowserUrl('file:///Users/me/other/x.html', { fullAccess: true }).ok, true, 'no project needed');
  assert.equal(checkBrowserUrl('data:text/html,hi', full).ok, true);
  assert.equal(checkBrowserUrl('javascript:void 0', full).ok, true);
  assert.equal(checkBrowserUrl('chrome://settings', full).ok, false, 'chrome: still unavailable');
  assert.equal(checkBrowserUrl('vscode://file/x', full).ok, false, 'no handing off to other apps');

  // ---- Ownership ------------------------------------------------------------------
  const parents = new Map([['child', 'parent'], ['grandchild', 'child']]);
  const agentTab = { id: 't1', ownerKey: 'parent', threadId: 'parent', controller: 'agent' };
  assert.equal(ownerKeyFor({ threadId: 'a' }), 'a');
  assert.equal(ownerKeyFor({ threadId: 'a', agentId: 'x' }), 'a:x');
  assert.equal(checkTabAccess(agentTab, { threadId: 'parent' }, { mutating: true, parents }).ok, true);
  assert.equal(checkTabAccess(agentTab, { threadId: 'child' }, { mutating: false, parents }).ok, true, 'subagent threads read the family');
  assert.equal(checkTabAccess(agentTab, { threadId: 'grandchild' }, { mutating: false, parents }).ok, true);
  assert.match(checkTabAccess(agentTab, { threadId: 'child' }, { mutating: true, parents }).reason, /another agent of this thread/);
  assert.match(checkTabAccess(agentTab, { threadId: 'stranger' }, { mutating: false, parents }).reason, /another Durango Code thread/);
  assert.match(checkTabAccess(agentTab, { threadId: 'parent', agentId: 'sub1' }, { mutating: true, parents }).reason, /another agent of this thread/);
  assert.equal(
    checkTabAccess({ ...agentTab, ownerKey: 'parent:sub1' }, { threadId: 'parent', agentId: 'sub1' }, { mutating: true, parents }).ok,
    true,
    'a Claude Task subagent owns its own tabs'
  );
  assert.equal(
    checkTabAccess({ ...agentTab, controller: 'user' }, { threadId: 'parent' }, { mutating: true, parents }).reason,
    'The user is controlling tab t1; wait or ask them.'
  );
  assert.equal(checkTabAccess({ ...agentTab, controller: 'user' }, { threadId: 'parent' }, { mutating: false, parents }).ok, true, 'reads still work while the user drives');
  const userTab = { id: 't9', ownerKey: 'user', threadId: null, controller: 'user' };
  assert.match(checkTabAccess(userTab, { threadId: 'parent' }, { mutating: false, parents }).reason, /Let agent use/);
  const many = Array.from({ length: MAX_TABS_PER_OWNER }, (_, index) => ({ id: `t${index}`, ownerKey: 'a' }));
  assert.equal(checkTabLimits(many, 'a').ok, false);
  assert.equal(checkTabLimits(many, 'b').ok, true);
  assert.equal(checkTabLimits(Array.from({ length: MAX_TABS_TOTAL }, () => ({ ownerKey: 'x' })), 'user').ok, false);

  // ---- Refs -------------------------------------------------------------------------
  const refs = createRefState();
  assert.match(resolveRef(refs, 'e1').reason, /Take a browser_snapshot first/);
  const allocate = beginRefGeneration(refs);
  assert.equal(allocate(101), 'e1');
  assert.equal(allocate(102), 'e2');
  assert.deepEqual(resolveRef(refs, 'e2'), { ok: true, backendNodeId: 102 });
  assert.deepEqual(resolveRef(refs, '[ref=e1]'), { ok: true, backendNodeId: 101 });
  const allocate2 = beginRefGeneration(refs);
  assert.equal(allocate2(101), 'e3', 'refs keep counting across snapshots');
  assert.match(resolveRef(refs, 'e1').reason, /stale: it came from an older snapshot/);
  assert.match(resolveRef(refs, 'e99').reason, /not in the latest snapshot/);
  assert.match(resolveRef(refs, 'button').reason, /not a snapshot ref/);
  invalidateRefs(refs, 'navigation');
  assert.match(resolveRef(refs, 'e3').reason, /the page navigated since that snapshot/);

  // ---- Snapshot format ----------------------------------------------------------------
  const ax = (nodeId, role, name, extra = {}) => ({
    nodeId: String(nodeId),
    role: { type: 'role', value: role },
    ...(name !== undefined ? { name: { type: 'computedString', value: name } } : {}),
    ...extra,
  });
  const fixture = [
    ax(1, 'RootWebArea', 'Sign in', { childIds: ['2', '3', '4', '5', '6', '9', '11'], backendDOMNodeId: 1 }),
    ax(2, 'heading', 'Welcome back', { parentId: '1', childIds: ['20'], backendDOMNodeId: 2, properties: [{ name: 'level', value: { type: 'integer', value: 1 } }] }),
    ax(20, 'StaticText', 'Welcome back', { parentId: '2' }),
    ax(3, 'generic', '', { parentId: '1', childIds: ['30', '31'], backendDOMNodeId: 3 }),
    ax(30, 'StaticText', 'Use your', { parentId: '3' }),
    ax(31, 'StaticText', 'work email.', { parentId: '3' }),
    ax(4, 'textbox', 'Email', {
      parentId: '1', backendDOMNodeId: 4, value: { type: 'string', value: 'me@x.dev' },
      properties: [{ name: 'focused', value: { type: 'boolean', value: true } }, { name: 'required', value: { type: 'boolean', value: true } }],
    }),
    ax(5, 'textbox', 'Password', { parentId: '1', backendDOMNodeId: 5, value: { type: 'string', value: 'hunter2' } }),
    ax(6, 'generic', '', { parentId: '1', ignored: true, childIds: ['7'] }),
    ax(7, 'checkbox', 'Remember me', { parentId: '6', backendDOMNodeId: 7, properties: [{ name: 'checked', value: { type: 'tristate', value: 'true' } }] }),
    ax(9, 'button', 'Continue', { parentId: '1', childIds: ['10'], backendDOMNodeId: 9, properties: [{ name: 'disabled', value: { type: 'boolean', value: true } }] }),
    ax(10, 'StaticText', 'Continue', { parentId: '9' }),
    ax(11, 'Iframe', '', { parentId: '1', backendDOMNodeId: 11 }),
  ];
  const frameNodes = [
    ax(1, 'RootWebArea', 'Captcha', { childIds: ['2'], backendDOMNodeId: 50 }),
    ax(2, 'link', 'Help', { parentId: '1', backendDOMNodeId: 51 }),
  ];
  const snapshotRefs = createRefState();
  const snapshot = buildSnapshot({
    tabId: 't2',
    url: 'https://x.dev/login',
    title: 'Sign in',
    nodes: fixture,
    frames: new Map([[11, frameNodes]]),
    maskedNodeIds: new Set([5]),
    allocateRef: beginRefGeneration(snapshotRefs),
  });
  assert.equal(
    snapshot.text,
    [
      'Tab t2 · https://x.dev/login · "Sign in"',
      '- heading "Welcome back" [ref=e1] [level=1]',
      '- text "Use your work email."',
      '- textbox "Email" [ref=e2] [focused] [required] [value="me@x.dev"]',
      '- textbox "Password" [ref=e3] [value="••••••"]',
      '- checkbox "Remember me" [ref=e4] [checked]',
      '- button "Continue" [ref=e5] [disabled]',
      '- Iframe [ref=e6]',
      '  - link "Help" [ref=e7]',
    ].join('\n')
  );
  assert.doesNotMatch(snapshot.text, /hunter2/, 'password values are masked');
  assert.deepEqual(resolveRef(snapshotRefs, 'e5'), { ok: true, backendNodeId: 9 });
  // Truncation keeps whole lines and says how many were cut.
  const long = [ax(1, 'RootWebArea', 'Long', { childIds: Array.from({ length: 400 }, (_, i) => String(i + 2)) })];
  for (let index = 0; index < 400; index += 1) long.push(ax(index + 2, 'link', `Link number ${index} with some padding text`, { parentId: '1', backendDOMNodeId: 1000 + index }));
  const truncated = buildSnapshot({ tabId: 't1', url: 'u', title: 't', nodes: long, allocateRef: beginRefGeneration(createRefState()), maxChars: 2000 });
  assert.ok(truncated.text.length <= 2000 + 120);
  assert.ok(truncated.truncatedLines > 300);
  assert.match(truncated.text, /… \d+ more lines \(pass a larger max_chars/);
  assert.equal(clampSnapshotMaxChars(10), 2000);
  assert.equal(clampSnapshotMaxChars(1e9), 60000);
  assert.equal(clampSnapshotMaxChars(undefined), 20000);

  // ---- Keys ---------------------------------------------------------------------------------
  assert.deepEqual(parseKeyCombo('Enter'), { keyCode: 'Return', modifiers: [], char: '\r' });
  assert.deepEqual(parseKeyCombo('Control+a'), { keyCode: 'a', modifiers: ['control'], char: null });
  assert.deepEqual(parseKeyCombo('Shift+ArrowDown'), { keyCode: 'Down', modifiers: ['shift'], char: null });
  assert.deepEqual(parseKeyCombo('Meta++'), { keyCode: '+', modifiers: ['meta'], char: null });
  assert.throws(() => parseKeyCombo('Hyper+x'), /Unknown modifier/);
  assert.throws(() => parseKeyCombo('Banana'), /Unknown key/);

  // ---- Settings migration / modes -----------------------------------------------------------------
  assert.equal(claudeBrowserSetting({}), 'builtin', 'built-in browser is the default');
  assert.equal(claudeBrowserSetting({ chrome: true }), 'chrome', 'legacy chrome:true keeps Claude in Chrome');
  assert.equal(claudeBrowserSetting({ chrome: false }), 'builtin');
  assert.equal(claudeBrowserSetting({ chrome: true, browser: 'off' }), 'off', 'the new setting wins');
  assert.equal(browserModeFor('claude', { chrome: true }, 'read-only'), 'builtin', 'no Claude in Chrome in Read only, built-in reads stay');
  assert.equal(browserModeFor('codex', { browserUseMode: 'extension' }, 'read-only'), 'builtin', 'no signed-in Chrome for Codex in Read only');
  // Your Chrome adds to the built-in browser instead of replacing it.
  for (const mode of ['builtin', 'chrome', 'external']) assert.equal(hasBuiltinBrowser(mode), true, `${mode} lists browser_* tools`);
  assert.equal(hasBuiltinBrowser('off'), false);
  assert.equal(signedInBrowserFor('builtin'), null);
  assert.match(signedInBrowserFor('chrome'), /mcp__claude-in-chrome__/);
  assert.match(signedInBrowserFor('external'), /environment note/);
  // Prompt routing: logins go to the user's Chrome.
  assert.match(builtinBrowserTips(signedInBrowserFor('chrome')), /Cloudflare[\s\S]*mcp__claude-in-chrome__[\s\S]*Never ask the user to sign in inside the built-in browser/);
  assert.match(builtinBrowserTips(null), /cannot reach the user's signed-in Chrome[\s\S]*request_user_action to sign in to that site in the built-in browser panel \(Take over/);
  assert.match(builtinBrowserTips(null), /sign in yourself if you have the credentials/);
  for (const tips of [builtinBrowserTips(null), builtinBrowserTips(signedInBrowserFor('chrome'))]) {
    assert.doesNotMatch(tips, /do not type|never type|secrets/i, 'no Durango-side limits on what the agent may type');
  }
  assert.doesNotMatch(signInHint(null), /never type/i);
  // Sign-in pages get a hint pointing at the user's Chrome.
  for (const url of [
    'https://dash.cloudflare.com/login',
    'https://dash.cloudflare.com/login?redirect_uri=x',
    'https://accounts.google.com/v3/signin/identifier',
    'https://github.com/login',
    'https://railway.com/login',
    'https://vercel.com/signin',
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    'https://example.com/oauth/authorize?client_id=1',
    'https://example.com/users/sign-in',
    'https://github.com/session/new',
  ]) assert.equal(looksLikeSignIn(url), true, url);
  for (const url of [
    'http://localhost:3000/',
    'https://dash.cloudflare.com/abc/workers',
    'https://example.com/blog/login-tips-for-teams',
    'https://example.com/author/jane',
    'https://example.com/',
    'about:blank',
  ]) assert.equal(looksLikeSignIn(url), false, url);
  assert.equal(looksLikeSignIn('http://localhost:3000/', '- textbox "Password" [ref=e4]'), true, 'a password field counts');
  assert.equal(looksLikeSignIn('https://durango.sh/', 'Tab t1 · https://durango.sh/\n  - button "Sign in" [ref=e3]\n  - text "No chats yet"'), true, 'signed out of an app without a login URL');
  assert.equal(looksLikeSignIn('https://example.com/', '  - link "Log in" [ref=e2]'), true);
  assert.equal(looksLikeSignIn('https://example.com/', '  - button "Continue with Google" [ref=e9]'), true);
  assert.equal(looksLikeSignIn('https://example.com/', '  - heading "How to sign in faster"\n  - link "Sign in tips for teams" [ref=e2]'), false, 'only a control named just sign in');
  assert.equal(looksLikeSignIn('https://example.com/', '  - button "Sign out" [ref=e2]'), false, 'signed in');
  assert.match(signInHint(signedInBrowserFor('chrome')), /asks for a sign-in[\s\S]*mcp__claude-in-chrome__[\s\S]*Do not ask the user to sign in here/);
  assert.match(signInHint(null), /request_user_action to sign in to that site in the built-in browser panel[\s\S]*take a new snapshot and continue/);
  assert.doesNotMatch(signInHint(signedInBrowserFor('chrome')), /built-in browser panel \(Take over/, 'with Chrome, no sign-in to the built-in browser');
  assert.equal(browserModeFor('claude', {}, 'read-only'), 'builtin', 'Read only keeps read access to the built-in browser');
  assert.equal(browserModeFor('codex', {}, 'full-access'), 'builtin');
  assert.equal(browserModeFor('codex', { browserUseMode: 'disabled' }, 'full-access'), 'off');
  assert.equal(browserModeFor('codex', { browserUseMode: 'extension' }, 'full-access'), 'external');
  assert.equal(browserModeFor('codex', { browserUseMode: 'mcp' }, 'full-access'), 'external');
  assert.equal(browserModeFor('codex', { browserControl: true, browserAutoConnect: true }, 'full-access'), 'external', 'legacy signed-in Chrome opt-in kept');
  assert.equal(browserModeFor('grok', {}, 'full-access'), 'builtin');
  assert.equal(browserModeFor('kimi', { browser: 'off' }, 'full-access'), 'off');
  assert.equal(
    browserModeFor('codex', codexBrowserOptionsForIntegration({ browserUseMode: 'extension' }, { ready: false }), 'full-access'),
    'external',
    'an unverified Codex extension stays the choice (the probe is advisory; built-in covers login-free pages)'
  );
  assert.equal(
    codexBrowserOptionsForIntegration({ browserUseMode: 'extension' }, { ready: false, builtinAvailable: false }).browserUseMode,
    'mcp',
    'without the bridge an unverified extension keeps the separate-profile fallback'
  );
  const claudeModel = { id: 'claude:x', providerId: 'claude', slug: 'claude-x' };
  const legacyChrome = claudeSdkOptionsForInput(claudeModel, { accessMode: 'workspace-write', providerOptions: { chrome: true } });
  assert.equal(legacyChrome.browser, 'chrome');
  assert.ok('chrome' in legacyChrome.extraArgs, '--chrome only for Claude in Chrome');
  assert.equal(hasBuiltinBrowser(legacyChrome.browser), true, 'Claude in Chrome users keep the built-in browser too');
  assert.ok(legacyChrome.allowedTools.includes('mcp__claude-in-chrome'));
  const builtinClaude = claudeSdkOptionsForInput(claudeModel, { accessMode: 'workspace-write', providerOptions: {} });
  assert.equal(builtinClaude.browser, 'builtin');
  assert.equal('chrome' in builtinClaude.extraArgs, false);
  assert.equal(claudeSdkOptionsForInput(claudeModel, { providerOptions: { browser: 'off', chrome: true } }).browser, 'off');
  assert.ok(commandForModel(claudeModel, { prompt: 'p', projectPath: '/tmp', providerOptions: { chrome: true } }).includes('--chrome'));
  assert.ok(!commandForModel(claudeModel, { prompt: 'p', projectPath: '/tmp', providerOptions: {} }).includes('--chrome'));
  assert.ok(!commandForModel(claudeModel, { prompt: 'p', projectPath: '/tmp', providerOptions: { browser: 'builtin', chrome: true } }).includes('--chrome'));

  // Grok/Kimi/fx approve orion tools by name.
  assert.deepEqual([...BROWSER_READ_TOOL_NAMES], [...READ_ONLY_BROWSER_TOOL_NAMES]);
  assert.equal(isPreapprovedOrionTool('browser_click', 'workspace-write'), true);
  assert.equal(isPreapprovedOrionTool('browser_click', 'read-only'), false);
  assert.equal(isPreapprovedOrionTool('browser_snapshot', 'read-only'), true);

  // ---- One schema source: Claude's zod tools mirror BROWSER_TOOLS ---------------------------
  const registerFor = (session) => {
    const registered = [];
    createOrionMcpServer(
      {
        createSdkMcpServer: (config) => config,
        tool: (name, description, schema, handler, extra) => {
          registered.push({ name, description, schema, handler, extra });
          return { name };
        },
      },
      { z },
      { threadId: 'thread-a', projectPath: testRoot, sender: null, ...session }
    );
    return registered.filter((entry) => entry.name.startsWith('browser_'));
  };
  assert.equal(registerFor({ accessMode: 'full-access' }).length, 0, 'no browser tools unless the session uses the built-in browser');
  assert.deepEqual(
    registerFor({ accessMode: 'full-access', browserMode: 'chrome' }).map((entry) => entry.name),
    BROWSER_TOOL_NAMES,
    'Claude in Chrome sessions also get the built-in browser'
  );
  assert.equal(registerFor({ accessMode: 'full-access', browserMode: 'off' }).length, 0);
  const claudeBrowser = registerFor({ accessMode: 'full-access', browserMode: 'builtin' });
  assert.deepEqual(claudeBrowser.map((entry) => entry.name), BROWSER_TOOL_NAMES);
  for (const definition of BROWSER_TOOLS) {
    const entry = claudeBrowser.find((candidate) => candidate.name === definition.name);
    assert.equal(entry.description, definition.description);
    assert.deepEqual(
      Object.keys(entry.schema).sort(),
      [...Object.keys(definition.inputSchema.properties), CLAUDE_BROWSER_AGENT_ARG].sort(),
      `${definition.name} schema keys`
    );
    const parsed = z.object(entry.schema).safeParse({});
    assert.equal(parsed.success, (definition.inputSchema.required ?? []).length === 0, `${definition.name} required fields`);
    assert.equal(Boolean(entry.extra?.annotations?.readOnlyHint), Boolean(definition.readOnly));
  }
  assert.equal(z.object(claudeBrowser.find((e) => e.name === 'browser_snapshot').schema).safeParse({ max_chars: 10 }).success, false, 'bounds carry over');
  assert.deepEqual(
    registerFor({ accessMode: 'read-only', browserMode: 'builtin' }).map((entry) => entry.name),
    READ_ONLY_BROWSER_TOOL_NAMES
  );
  // The PreToolUse hook stamps a Task subagent's id into _agent.
  const [preToolUse] = claudeBrowserAgentHooks().PreToolUse;
  assert.equal(new RegExp(preToolUse.matcher).test('mcp__orion__browser_click'), true);
  assert.equal(new RegExp(preToolUse.matcher).test('mcp__orion__spawn_subagent'), false);
  assert.deepEqual(await preToolUse.hooks[0]({ tool_input: { ref: 'e1' } }), { continue: true });
  assert.deepEqual(
    (await preToolUse.hooks[0]({ agent_id: 'ag1', tool_input: { ref: 'e1' } })).hookSpecificOutput.updatedInput,
    { ref: 'e1', _agent: 'ag1' }
  );

  // ---- End to end: real tabs in a hidden window ----------------------------------------------------
  await app.whenReady();
  trace('ready');
  const pages = {
    '/': `<!doctype html><title>Form page</title>
      <h1>Hello browser</h1>
      <p id="status">idle</p>
      <form id="f" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'submitted:' + document.getElementById('email').value;">
        <label>Email <input id="email" name="email"></label>
        <label>Secret <input id="pw" type="password" value="hunter2"></label>
        <label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro plan</option></select></label>
        <button type="button" id="b" onclick="document.getElementById('status').textContent = 'clicked'">Press me</button>
        <button type="submit">Send</button>
      </form>
      <button id="alerter" onclick="document.getElementById('status').textContent = confirm('Sure?') ? 'yes' : 'no'">Ask</button>
      <a href="/two">Go to two</a>
      <button id="later" onclick="setTimeout(() => document.getElementById('status').textContent = 'ready later', 300)">Later</button>
      <button id="opener" onclick="window.open('/two')">Popup</button>
      <div style="position:relative;height:40px"><button id="hidden-btn">Under</button><div style="position:absolute;inset:0;background:red">cover</div></div>
      <script>document.getElementById('plan').addEventListener('change', (e) => document.getElementById('status').textContent = 'plan:' + e.target.value)</script>`,
    '/two': '<!doctype html><title>Page two</title><h1>Second page</h1>',
    // Two frames in different renderer processes with a confirm() each: #fa on
    // the other origin (localhost, an out-of-process frame) and #fb on this one.
    '/frames': `<!doctype html><title>Frames</title>
      <script>window.log = []; addEventListener('message', (event) => log.push(event.data));</script>
      <iframe id="fa" src="FRAME_A_URL"></iframe><iframe id="fb" src="/frame-b"></iframe>`,
    '/frame-a': `<!doctype html><title>Frame A</title><script>
      addEventListener('message', (event) => { if (event.data === 'ask') parent.postMessage('A:' + confirm('Frame A?'), '*'); });
      parent.postMessage('A:ready', '*');</script>`,
    '/frame-b': `<!doctype html><title>Frame B</title><script>window.ask = () => parent.log.push('B:' + confirm('Frame B?'));</script>`,
    // Drag state kept from mousedown (which opens an alert) until mouseup.
    '/drag': `<!doctype html><title>Drag</title><style>body{margin:0}#handle{position:absolute;left:20px;top:20px;width:200px;height:100px}</style>
      <div id="handle">Drag me</div><script>
      window.dragging = false; window.moves = 0; window.seen = [];
      const handle = document.getElementById('handle');
      handle.addEventListener('mousedown', () => { dragging = true; seen.push('mousedown'); alert('Pressed'); });
      document.addEventListener('mouseup', (event) => { dragging = false; seen.push('mouseup:' + (event.target.id || event.target.tagName)); });
      document.addEventListener('click', (event) => seen.push('click:' + (event.target.id || event.target.tagName)));
      document.addEventListener('mousemove', () => { if (dragging) moves += 1; });</script>`,
    '/downloads': '<!doctype html><title>Downloads</title><a id="dl" href="/report.txt">Get report</a>',
    // A sign-in style popup that reports back to its opener and closes, and a form POST into a new tab.
    '/opener': `<!doctype html><title>Opener</title><p id="status">idle</p>
      <button id="pop" onclick="window.popupRef = window.open('/popup-child', 'signin', 'width=500,height=600')">Sign in with popup</button>
      <form method="post" action="/echo" target="_blank"><input name="who" value="durango"><button type="submit">Post to new tab</button></form>
      <script>addEventListener('message', (event) => { document.getElementById('status').textContent = 'got:' + event.data + ':' + (event.source === window.popupRef ? 'from-popup' : 'other'); });</script>`,
    '/popup-child': `<!doctype html><title>Popup child</title><p>Signing in</p>
      <script>window.opener.postMessage(window.opener ? 'signed-in' : 'no-opener', '*'); setTimeout(() => window.close(), 200);</script>`,
  };
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && new URL(request.url, 'http://x').pathname === '/echo') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<!doctype html><title>Echo ${body}</title><h1>Posted</h1>`);
      });
      return;
    }
    if (new URL(request.url, 'http://x').pathname === '/report.txt') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' });
      response.end('report body');
      return;
    }
    const body = pages[new URL(request.url, 'http://x').pathname]?.replace('FRAME_A_URL', `http://localhost:${server.address().port}/frame-a`);
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    response.end(body ?? 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, width: 1200, height: 800 });
  // Count native message boxes: a page's dialog must never open one (it would
  // show the hidden window, take key focus and outlive the CDP answer).
  const nativeDialogs = [];
  dialog.showMessageBox = (...args) => {
    nativeDialogs.push(args);
    return new Promise(() => {});
  };
  dialog.showMessageBoxSync = (...args) => {
    nativeDialogs.push(args);
    return 0;
  };
  {
    // Control: without the hook, Electron 42 shows a guest's confirm() natively,
    // so the counter above sees native dialogs; with it, nothing native opens.
    const bare = new WebContentsView();
    window.contentView.addChildView(bare);
    assert.equal(
      canRouteGuestDialogs(bare.webContents),
      true,
      "Electron's internal '-run-dialog' handler changed: update src/main/browser/guest-dialogs.js (see docs/builtin-browser.md)"
    );
    await bare.webContents.loadURL('about:blank');
    bare.webContents.debugger.attach('1.3');
    await bare.webContents.debugger.sendCommand('Page.enable');
    const answered = bare.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'confirm("native?")', returnByValue: true });
    const started = Date.now();
    while (nativeDialogs.length === 0 && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(nativeDialogs.length, 1, 'without the hook a guest confirm() opens a native dialog (the counter works)');
    await bare.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true });
    assert.equal((await answered).result.value, true);
    window.contentView.removeChildView(bare);
    bare.webContents.close();
    nativeDialogs.length = 0;
  }
  const events = [];
  const manager = createBrowserManager({ getWindow: () => window, emit: (channel, payload) => events.push({ channel, payload }) });
  setBrowserManager(manager, { screenshotsDirectory: path.join(testRoot, 'shots') });
  // Clear browsing data before any tab exists must not lose the download approval.
  assert.deepEqual(await manager.userActions.clearData(), { ok: true });

  const projectDir = path.join(testRoot, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'index.html'), '<title>Local file</title><h1>From disk</h1>');
  const caller = { threadId: 'thread-a', projectPath: projectDir, accessMode: 'full-access' };
  const run = async (name, args = {}, who = caller) => {
    trace('→', name, JSON.stringify(args));
    const result = await runBrowserTool(name, args, who);
    trace('←', result.ok, result.text.slice(0, 160).replace(/\n/g, ' ⏎ '));
    return result;
  };
  const refOf = (text, pattern) => {
    const line = text.split('\n').find((candidate) => pattern.test(candidate));
    assert.ok(line, `snapshot has a line matching ${pattern}:\n${text}`);
    return /\[ref=(e\d+)\]/.exec(line)[1];
  };
  const status = async () => (await run('browser_evaluate', { expression: "document.getElementById('status').textContent" })).text;
  const waitUntil = async (check, label, timeoutMs = 5000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  try {
    assert.match((await run('browser_status')).text, /no tabs you can use/);
    assert.match((await run('browser_click', { ref: 'e1' })).text, /no browser tab yet/);

    const opened = await run('browser_open', { url: `${origin}/` });
    assert.equal(opened.ok, true, opened.text);
    assert.match(opened.text, /Opened tab t1\. Tab t1 loaded .*"Form page"/);
    assert.ok(events.some((event) => event.payload?.event?.type === 'agent-opened' && event.payload.event.threadId === 'thread-a'));

    let snap = await run('browser_snapshot');
    assert.equal(snap.ok, true, snap.text);
    assert.match(snap.text, /^Tab t1 · http:\/\/127\.0\.0\.1:\d+\/ · "Form page"/);
    assert.match(snap.text, /- heading "Hello browser" \[ref=e\d+\] \[level=1\]/);
    assert.doesNotMatch(snap.text, /hunter2/);

    // Click by ref.
    assert.equal((await run('browser_click', { ref: refOf(snap.text, /button "Press me"/) })).ok, true);
    assert.equal(await status(), 'clicked');

    // Type + submit (Enter through sendInputEvent submits the form).
    const typedOnly = await run('browser_type', { ref: refOf(snap.text, /textbox "Email"/), text: 'me@' });
    assert.equal(typedOnly.ok, true, typedOnly.text);
    assert.equal((await run('browser_evaluate', { expression: "document.getElementById('email').value" })).text, 'me@');
    const typed = await run('browser_type', { ref: refOf(snap.text, /textbox "Email"/), text: 'x.dev', submit: true });
    assert.equal(typed.ok, true, typed.text);
    assert.equal(await status(), 'submitted:me@x.dev');
    const retyped = await run('browser_type', { ref: refOf(snap.text, /textbox "Email"/), text: 'new@x.dev', clear: true });
    assert.equal(retyped.ok, true, retyped.text);
    assert.equal((await run('browser_evaluate', { expression: "document.getElementById('email').value" })).text, 'new@x.dev');
    assert.match((await run('browser_type', { ref: refOf(snap.text, /button "Press me"/), text: 'x' })).text, /does not take text/);

    // Select by label.
    const selected = await run('browser_select', { ref: refOf(snap.text, /combobox "Plan"/), values: ['Pro plan'] });
    assert.equal(selected.ok, true, selected.text);
    assert.equal(await status(), 'plan:pro');
    assert.match((await run('browser_select', { ref: refOf(snap.text, /combobox "Plan"/), values: ['Enterprise'] })).text, /No option .* matches/);

    // A covered element is refused with what covers it.
    const covered = await run('browser_click', { ref: refOf(snap.text, /button "Under"/) });
    assert.equal(covered.ok, false);
    assert.match(covered.text, /is covered by div/);

    // Evaluate: JSON results, thrown errors.
    assert.equal((await run('browser_evaluate', { expression: '({ a: 1 })' })).text, '{\n  "a": 1\n}');
    assert.equal((await run('browser_evaluate', { expression: 'Promise.resolve(42)' })).text, '42');
    assert.match((await run('browser_evaluate', { expression: 'throw new Error("boom")' })).text, /boom/);

    // wait_for
    await run('browser_click', { ref: refOf(snap.text, /button "Later"/) });
    const waited = await run('browser_wait_for', { text: 'ready later', timeout_ms: 3000 });
    assert.equal(waited.ok, true, waited.text);
    assert.equal((await run('browser_wait_for', { text: 'never shows', timeout_ms: 300 })).ok, false);

    // JavaScript dialogs block the page and agent actions until answered, and
    // never open native UI (the window stays hidden, nothing takes key focus).
    assert.equal(manager.findTab('t1').guestDialogs.installed, true, 'guest dialogs are routed away from native UI');
    const clickedAsk = await run('browser_click', { ref: refOf(snap.text, /button "Ask"/) });
    assert.match(clickedAsk.text, /A confirm dialog is open: "Sure\?"\. Answer it with browser_dialog/, 'the click returns once the dialog shows');
    assert.equal(manager.findTab('t1').dialog?.type, 'confirm', 'the confirm dialog is tracked');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(manager.findTab('t1').dialog?.type, 'confirm', 'nothing answers the dialog by itself');
    assert.match((await run('browser_snapshot')).text, /A confirm dialog is open: "Sure\?"/);
    assert.match((await run('browser_click', { x: 5, y: 5 })).text, /Answer it with browser_dialog/);
    assert.equal((await run('browser_dialog', { accept: false })).ok, true);
    assert.equal(await status(), 'no');
    // Accepting returns true to the page.
    await run('browser_click', { ref: refOf(snap.text, /button "Ask"/) });
    assert.equal((await run('browser_dialog', { accept: true })).ok, true);
    assert.equal(await status(), 'yes');
    // alert() answered from the panel; the script resumes only then.
    await run('browser_evaluate', { expression: "setTimeout(() => { alert('Heads up'); document.getElementById('status').textContent = 'after-alert'; }, 0); 1" });
    {
      const started = Date.now();
      while (!manager.findTab('t1').dialog && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(
      { type: manager.findTab('t1').dialog?.type, message: manager.findTab('t1').dialog?.message },
      { type: 'alert', message: 'Heads up' }
    );
    assert.ok(events.some((event) => event.payload?.event?.type === 'dialog-opened' && event.payload.event.tabId === 't1'));
    assert.deepEqual(await manager.userActions.answerDialog({ tabId: 't1', accept: true }), { ok: true });
    assert.equal(manager.findTab('t1').dialog, null);
    assert.equal(await status(), 'after-alert');

    // Two frames (different renderer processes) with a confirm() open at once:
    // they queue, the first stays shown until answered, each gets its own answer.
    {
      const tab = manager.findTab('t1');
      const parentLog = async () => JSON.parse((await run('browser_evaluate', { expression: 'JSON.stringify(log)' })).text);
      const openBoth = async () => {
        await run('browser_evaluate', { expression: "document.getElementById('fa').contentWindow.postMessage('ask', '*'); 1" });
        await waitUntil(() => tab.dialog?.message === 'Frame A?', 'frame A\'s confirm');
        // Straight through CDP: agent actions wait while a dialog is open.
        await tab.cdp.send('Runtime.evaluate', { expression: "setTimeout(() => document.getElementById('fb').contentWindow.ask(), 0); 1" });
        await waitUntil(() => tab.guestDialogs.count === 2, 'frame B\'s confirm queued behind frame A\'s');
      };
      assert.equal((await run('browser_navigate', { url: `${origin}/frames` })).ok, true);
      await waitUntil(async () => (await parentLog()).includes('A:ready'), 'frame A to load');
      assert.notEqual(
        tab.view.webContents.mainFrame.frames.find((frame) => frame.url.includes('/frame-a'))?.osProcessId,
        tab.view.webContents.mainFrame.osProcessId,
        'frame A runs in another renderer process'
      );
      await openBoth();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(tab.dialog?.message, 'Frame A?', 'the first dialog stays shown');
      const firstId = tab.dialog.id;
      const answeredA = await run('browser_dialog', { accept: true });
      assert.match(answeredA.text, /^Accepted the confirm dialog "Frame A\?" .*Another confirm dialog is open now: "Frame B\?"/);
      assert.equal(tab.dialog?.message, 'Frame B?', 'the next dialog is shown');
      assert.equal(tab.dialog?.url, `${origin}/frame-b`);
      assert.deepEqual(await manager.userActions.answerDialog({ tabId: 't1', dialogId: firstId, accept: true }), { ok: false }, 'a stale panel answer is ignored');
      assert.deepEqual(await manager.userActions.answerDialog({ tabId: 't1', dialogId: tab.dialog.id, accept: false }), { ok: true });
      assert.equal(tab.dialog, null);
      await waitUntil(async () => (await parentLog()).length === 3, 'both answers');
      assert.deepEqual((await parentLog()).slice(1).sort(), ['A:true', 'B:false'], 'each frame got its own answer');
      // Navigating away settles every held dialog (both renderers resume).
      await openBoth();
      tab.view.webContents.loadURL(`${origin}/two`).catch(() => {});
      await waitUntil(() => !tab.dialog && tab.guestDialogs.count === 0, 'navigation to cancel both dialogs');
      await waitUntil(() => tab.view.webContents.getTitle() === 'Page two', 'the navigation to finish');
      assert.equal((await run('browser_evaluate', { expression: '1 + 1' })).text, '2');
    }

    // A mousedown that opens an alert: the click returns with the press held,
    // and answering the alert releases it (the page's drag state ends).
    {
      const tab = manager.findTab('t1');
      const page = async () => JSON.parse((await run('browser_evaluate', { expression: 'JSON.stringify({ seen, dragging, moves })' })).text);
      // Mouse moves after the release don't drag (moves counts mousemoves
      // while dragging; letting go outside the page moves the pointer out first).
      const moveMouse = async () => {
        await run('browser_evaluate', { expression: 'moves = 0' });
        for (const [x, y] of [[300, 300], [320, 310], [340, 330]]) {
          await tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
        }
      };
      // The agent still controls the tab: the release completes its click.
      assert.equal((await run('browser_navigate', { url: `${origin}/drag` })).ok, true);
      const pressed = await run('browser_click', { x: 100, y: 60 });
      assert.match(pressed.text, /A alert dialog is open: "Pressed"/);
      assert.ok(tab.pendingPress, 'the press is held while the alert is open');
      assert.equal((await run('browser_dialog', { accept: true })).ok, true);
      assert.equal(tab.pendingPress, null);
      await moveMouse();
      assert.deepEqual(await page(), { seen: ['mousedown', 'mouseup:handle', 'click:handle'], dragging: false, moves: 0 });
      // The user took over while the alert was open: let go without a click.
      assert.equal((await run('browser_navigate', { url: `${origin}/drag` })).ok, true);
      await run('browser_click', { x: 100, y: 60 });
      assert.ok(tab.pendingPress);
      manager.userActions.takeControl({ tabId: 't1' });
      assert.deepEqual(await manager.userActions.answerDialog({ tabId: 't1', accept: true }), { ok: true });
      manager.userActions.releaseControl({ tabId: 't1' });
      await moveMouse();
      assert.deepEqual(await page(), { seen: ['mousedown', 'mouseup:HTML', 'click:HTML'], dragging: false, moves: 0 });
      // The next agent click works.
      await run('browser_click', { x: 100, y: 60 });
      assert.equal((await run('browser_dialog', { accept: true })).ok, true);
      assert.deepEqual((await page()).seen.slice(-3), ['mousedown', 'mouseup:handle', 'click:handle']);
    }
    assert.equal((await run('browser_navigate', { url: `${origin}/` })).ok, true);
    assert.equal(nativeDialogs.length, 0, 'no native dialog opened for the page');
    assert.equal(window.isVisible(), false, 'the hidden window stayed hidden');

    // Ownership: another thread cannot use this tab; the user taking over pauses the agent.
    const stranger = { threadId: 'thread-b', accessMode: 'full-access' };
    assert.match((await run('browser_click', { tab: 't1', x: 1, y: 1 }, stranger)).text, /another Durango Code thread/);
    assert.match((await run('browser_status', {}, stranger)).text, /no tabs you can use/);
    manager.userActions.setThreadParents({ 'thread-a-child': 'thread-a' });
    assert.match((await run('browser_snapshot', { tab: 't1' }, { threadId: 'thread-a-child' })).text, /Tab t1/, 'subagent threads can read');
    assert.match((await run('browser_click', { tab: 't1', x: 1, y: 1 }, { threadId: 'thread-a-child' })).text, /another agent of this thread/);
    manager.userActions.takeControl({ tabId: 't1' });
    assert.equal((await run('browser_click', { x: 1, y: 1 })).text, 'The user is controlling tab t1; wait or ask them.');
    assert.match((await run('browser_status')).text, /the user is controlling it/);
    manager.userActions.releaseControl({ tabId: 't1' });

    // Read only: status and snapshots only.
    const readOnly = { ...caller, accessMode: 'read-only' };
    assert.equal((await run('browser_snapshot', {}, readOnly)).ok, true);
    assert.match((await run('browser_click', { x: 1, y: 1 }, readOnly)).text, /not available in Read only/);
    assert.match((await run('browser_open', { url: origin }, readOnly)).text, /not available in Read only/);

    // Screenshots come back as an image and a file.
    const shot = await run('browser_snapshot', { screenshot: true });
    assert.equal(shot.ok, true, shot.text);
    assert.equal(shot.images?.length, 1, shot.text);
    assert.equal(shot.images[0].mimeType, 'image/jpeg');
    const shotPath = /saved to (.+\.jpg)/.exec(shot.text)[1];
    assert.ok((await fs.stat(shotPath)).size > 1000);

    // Navigation invalidates refs.
    const before = await run('browser_snapshot');
    const linkRef = refOf(before.text, /link "Go to two"/);
    assert.equal((await run('browser_click', { ref: linkRef })).ok, true);
    assert.match((await run('browser_wait_for', { url_includes: '/two' })).text, /Condition met/);
    assert.match((await run('browser_click', { ref: linkRef })).text, /stale: the page navigated/);
    const back = await run('browser_navigate', { action: 'back' });
    assert.match(back.text, /"Form page"/);
    // Workspace-write keeps the file:/javascript: limits; Full access lifts them.
    const limited = { ...caller, accessMode: 'workspace-write' };
    assert.match((await run('browser_navigate', { url: 'javascript:alert(1)' }, limited)).text, /blocked/);
    assert.match((await run('browser_navigate', { url: 'file:///etc/hosts' }, limited)).text, /only allowed inside the project/);
    const hostsFile = await run('browser_navigate', { url: 'file:///etc/hosts' });
    assert.doesNotMatch(hostsFile.text, /only allowed inside the project|blocked/, hostsFile.text);
    assert.equal((await run('browser_navigate', { url: 'data:text/html,<title>Inline</title>' })).text.includes('"Inline"'), true, 'top-level data: in Full access');
    await run('browser_navigate', { url: `${origin}/` });
    const local = await run('browser_navigate', { url: path.join(projectDir, 'index.html') });
    assert.match(local.text, /"Local file"/, local.text);

    // Downloads: held for the user's Save by default, straight through when the setting is off.
    {
      const waitFor = async (check, label) => {
        for (let i = 0; i < 100; i += 1) {
          const value = await check();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`timed out waiting for ${label}: ${JSON.stringify(manager.state().tabs.map((entry) => ({ id: entry.id, url: entry.url, pending: entry.pendingDownload, last: entry.lastDownload })))}`);
      };
      await run('browser_navigate', { url: `${origin}/downloads` });
      const dlRef = refOf((await run('browser_snapshot')).text, /link "Get report"/);
      await run('browser_click', { ref: dlRef });
      const pending = await waitFor(() => manager.state().tabs.find((entry) => entry.pendingDownload)?.pendingDownload, 'a pending download');
      assert.equal(pending.filename, 'report.txt');
      assert.match((await run('browser_status')).text, /download of report\.txt waiting for the user to approve it/);
      assert.ok(events.some((entry) => entry.payload?.event?.type === 'download-requested'), 'the panel is told to ask');
      const pendingTab = manager.state().tabs.find((entry) => entry.pendingDownload);
      assert.deepEqual(await manager.userActions.answerDownload({ tabId: pendingTab.id, id: pending.id, accept: true }), { ok: true });
      const saved = await waitFor(() => manager.state().tabs.find((entry) => entry.id === pendingTab.id)?.lastDownload, 'the saved download');
      assert.equal(saved.state, 'completed');
      assert.equal(await fs.readFile(saved.path, 'utf8'), 'report body');
      assert.match((await run('browser_status')).text, /last download saved to /);
      // Cancel discards it.
      await run('browser_click', { ref: dlRef });
      const second = await waitFor(() => manager.state().tabs.find((entry) => entry.pendingDownload)?.pendingDownload, 'a second pending download');
      await manager.userActions.answerDownload({ tabId: pendingTab.id, id: second.id, accept: false });
      assert.equal((await waitFor(() => manager.state().tabs.find((entry) => entry.id === pendingTab.id)?.lastDownload?.state === 'cancelled' && 'cancelled', 'cancel')), 'cancelled');
      // Setting off: saved without asking.
      manager.userActions.setOptions({ askBeforeDownload: false });
      await run('browser_click', { ref: dlRef });
      const direct = await waitFor(() => {
        const entry = manager.state().tabs.find((candidate) => candidate.id === pendingTab.id);
        return entry?.lastDownload?.state === 'completed' && entry.lastDownload.path !== saved.path && entry.lastDownload;
      }, 'a direct download');
      assert.equal(manager.state().tabs.some((entry) => entry.pendingDownload), false, 'no question when the setting is off');
      assert.equal(await fs.readFile(direct.path, 'utf8'), 'report body');
      manager.userActions.setOptions({ askBeforeDownload: true });
      await run('browser_navigate', { url: `${origin}/` });
    }

    // Resize presets.
    assert.match((await run('browser_resize', { preset: 'mobile' })).text, /390×844 as a mobile device/);
    assert.equal((await run('browser_evaluate', { expression: 'screen.width' })).text, '390');
    assert.match((await run('browser_resize', { preset: 'reset' })).text, /panel's size/);

    // browser_open reuses the tab; new_tab opens another; popups become tabs.
    assert.match((await run('browser_open', { url: `${origin}/` })).text, /reused your tab t1/);
    const second = await run('browser_open', { url: `${origin}/two`, new_tab: true });
    assert.match(second.text, /Opened tab t2/);
    assert.match((await run('browser_status')).text, /t1 ·[\s\S]*t2 ·/);
    const snap2 = await run('browser_snapshot', { tab: 't1' });
    await run('browser_click', { tab: 't1', ref: refOf(snap2.text, /button "Popup"/) });
    const popupDeadline = Date.now() + 3000;
    while (!manager.findTab('t3') && Date.now() < popupDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(manager.findTab('t3')?.ownerKey, 'thread-a', 'popups belong to the opener');

    // A Claude Task subagent gets its own tabs.
    const sub = { ...caller, agentId: 'ag1' };
    assert.match((await run('browser_snapshot', {}, sub)).text, /Tab t\d/, 'reads fall back to the thread family');
    assert.match((await run('browser_click', { tab: 't1', x: 1, y: 1 }, sub)).text, /another agent of this thread/);
    const subOpened = await run('browser_open', { url: `${origin}/two` }, sub);
    assert.match(subOpened.text, /Opened tab t4/);
    assert.equal(manager.findTab('t4').ownerKey, 'thread-a:ag1');

    // User tabs need "Let agent use".
    const userTab = await manager.userActions.create({ url: `${origin}/two` });
    assert.match((await run('browser_snapshot', { tab: userTab.tabId })).text, /Let agent use/);
    manager.userActions.adopt({ tabId: userTab.tabId, threadId: 'thread-a' });
    assert.equal((await run('browser_snapshot', { tab: userTab.tabId })).ok, true);

    // Through the bridge shim: browser tools listed only for builtin runs, image blocks passed through.
    const shimPath = path.join(testRoot, 'shim.cjs');
    await fs.writeFile(shimPath, shimSource);
    const socketPath = path.join(testRoot, 'bridge.sock');
    const bridgeServer = net.createServer(handleMcpBridgeConnection);
    await new Promise((resolve) => bridgeServer.listen(socketPath, resolve));
    mcpBridgeSessions.set('tok-on', { getSender: () => null, threadId: 'thread-a', projectPath: projectDir, providerId: 'codex', accessMode: 'full-access', browserMode: 'builtin' });
    mcpBridgeSessions.set('tok-ro', { getSender: () => null, threadId: 'thread-a', projectPath: projectDir, providerId: 'grok', accessMode: 'read-only', browserMode: 'builtin' });
    mcpBridgeSessions.set('tok-off', { getSender: () => null, threadId: 'thread-a', projectPath: projectDir, providerId: 'grok', accessMode: 'full-access', browserMode: 'off' });
    const startShim = (token) => {
      const child = spawn(process.execPath, [shimPath, '--socket', socketPath, '--token', token], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const waiters = new Map();
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          waiters.get(message.id)?.(message);
        }
      });
      let nextId = 1;
      const call = (method, params) =>
        new Promise((resolve) => {
          const id = nextId++;
          waiters.set(id, resolve);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
      return { child, call };
    };
    const on = startShim('tok-on');
    const ro = startShim('tok-ro');
    const off = startShim('tok-off');
    try {
      const listed = (await on.call('tools/list', {})).result.tools;
      for (const definition of BROWSER_TOOLS) {
        const tool = listed.find((candidate) => candidate.name === definition.name);
        assert.ok(tool, `shim lists ${definition.name}`);
        assert.equal(tool.description, definition.description);
        assert.deepEqual(tool.inputSchema, definition.inputSchema, `${definition.name} schema is browser-tools.js's`);
      }
      assert.ok(listed.some((tool) => tool.name === 'spawn_subagent'), 'fixed tools are still listed');
      assert.deepEqual(
        (await ro.call('tools/list', {})).result.tools.filter((tool) => tool.name.startsWith('browser_')).map((tool) => tool.name),
        READ_ONLY_BROWSER_TOOL_NAMES
      );
      assert.equal((await off.call('tools/list', {})).result.tools.some((tool) => tool.name.startsWith('browser_')), false);
      const offCall = await off.call('tools/call', { name: 'browser_status', arguments: {} });
      assert.equal(offCall.error?.code, -32602, 'tools of a run without the built-in browser are unknown');
      const viaShim = await on.call('tools/call', { name: 'browser_snapshot', arguments: { tab: 't1', screenshot: true } });
      assert.equal(viaShim.result.isError, false, JSON.stringify(viaShim.result).slice(0, 300));
      assert.equal(viaShim.result.content[0].type, 'text');
      assert.match(viaShim.result.content[0].text, /^Tab t1/);
      assert.equal(viaShim.result.content[1].type, 'image');
      assert.equal(viaShim.result.content[1].mimeType, 'image/jpeg');
      assert.ok(viaShim.result.content[1].data.length > 1000);
      const textOnly = await on.call('tools/call', { name: 'browser_status', arguments: {} });
      assert.deepEqual(textOnly.result.content.map((block) => block.type), ['text'], 'text-only replies stay one text block');
      const denied = await on.call('tools/call', { name: 'browser_click', arguments: { tab: 't99', x: 1, y: 1 } });
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /no tab t99/);
    } finally {
      for (const shim of [on, ro, off]) shim.child.kill();
      bridgeServer.close();
      for (const token of ['tok-on', 'tok-ro', 'tok-off']) mcpBridgeSessions.delete(token);
    }


    // Two tabs holding a download of the same name get different files; neither replaces the other.
    {
      const other = { threadId: 'thread-c', projectPath: projectDir, accessMode: 'full-access' };
      const tabA = manager.findTab(/Opened tab (t\d+)/.exec((await run('browser_open', { url: `${origin}/downloads` }, other)).text)[1]);
      const tabB = manager.findTab(/Opened tab (t\d+)/.exec((await run('browser_open', { url: `${origin}/downloads`, new_tab: true }, other)).text)[1]);
      assert.notEqual(tabA.id, tabB.id);
      for (const tab of [tabA, tabB]) {
        const ref = refOf((await run('browser_snapshot', { tab: tab.id }, other)).text, /link "Get report"/);
        await run('browser_click', { tab: tab.id, ref }, other);
      }
      await waitUntil(() => tabA.pendingDownload?.finished && tabB.pendingDownload?.finished, 'two held downloads');
      assert.notEqual(tabA.pendingDownload.finalPath, tabB.pendingDownload.finalPath, 'held downloads reserve different names');
      await manager.userActions.answerDownload({ tabId: tabA.id, accept: true });
      await manager.userActions.answerDownload({ tabId: tabB.id, accept: true });
      await waitUntil(() => tabA.lastDownload && tabB.lastDownload, 'both saved');
      assert.equal(tabA.lastDownload.state, 'completed');
      assert.equal(tabB.lastDownload.state, 'completed');
      assert.notEqual(tabA.lastDownload.path, tabB.lastDownload.path);
      assert.equal(await fs.readFile(tabA.lastDownload.path, 'utf8'), 'report body');
      assert.equal(await fs.readFile(tabB.lastDownload.path, 'utf8'), 'report body');
      // A file that appears at the reserved name meanwhile is not replaced either.
      const moveDir = path.join(testRoot, 'move');
      await fs.mkdir(moveDir, { recursive: true });
      const reserved = reserveDownloadPath(moveDir, 'notes.txt');
      await fs.writeFile(reserved, 'someone else');
      const held = path.join(moveDir, 'held');
      await fs.writeFile(held, 'mine');
      const moved = await moveHeldDownload(held, reserved);
      assert.equal(moved, path.join(moveDir, 'notes (1).txt'));
      assert.equal(await fs.readFile(reserved, 'utf8'), 'someone else');
      assert.equal(await fs.readFile(moved, 'utf8'), 'mine');
      assert.equal(reserveDownloadPath(moveDir, 'notes.txt'), path.join(moveDir, 'notes (2).txt'), 'the reservation is released');
      manager.userActions.closeThreadTabs({ threadId: 'thread-c' });
    }

    // Take over while an action waits out the user's typing: the action does not run.
    {
      const tab = manager.findTab('t1');
      await run('browser_navigate', { tab: 't1', url: `${origin}/` });
      tab.humanInputUntil = Date.now() + 750;
      const pendingAction = run('browser_evaluate', { tab: 't1', expression: "document.getElementById('status').textContent = 'agent ran'" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      manager.userActions.takeControl({ tabId: 't1' });
      const refused = await pendingAction;
      assert.equal(refused.ok, false);
      assert.equal(refused.text, 'The user is controlling tab t1; wait or ask them.');
      manager.userActions.releaseControl({ tabId: 't1' });
      assert.notEqual(await status(), 'agent ran', 'the action did not run after Take over');
      // Take over between the access check and the input itself also stops it.
      tab.controller = 'user';
      assert.throws(() => tab.markAgentInput(), /The user is controlling tab t1/);
      tab.controller = 'agent';

      // Take over after the mouse press is acknowledged but before the release:
      // the button is let go outside the page, the element is not clicked, and
      // the action fails. Also when the page captured the pointer in
      // pointerdown (setPointerCapture would otherwise route the release, and
      // the click, back to the button).
      for (const capture of [false, true]) {
        await run('browser_navigate', { tab: 't1', url: `${origin}/` });
        await run('browser_evaluate', {
          tab: 't1',
          expression: `window.__pointer = []; for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) document.addEventListener(type, (event) => window.__pointer.push(type + ':' + (event.target.id || event.target.tagName)), true);
            ${capture ? "document.getElementById('b').addEventListener('pointerdown', (event) => event.target.setPointerCapture(event.pointerId));" : ''} 1`,
        });
        const pressRef = refOf((await run('browser_snapshot', { tab: 't1' })).text, /button "Press me"/);
        const realSend = tab.cdp.send;
        const sent = [];
        tab.cdp.send = async (method, params, ...rest) => {
          if (method === 'Input.dispatchMouseEvent') sent.push(params.type);
          const result = await realSend(method, params, ...rest);
          if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') manager.userActions.takeControl({ tabId: 't1' });
          return result;
        };
        let tookOver;
        try {
          tookOver = await run('browser_click', { tab: 't1', ref: pressRef });
        } finally {
          tab.cdp.send = realSend;
        }
        assert.equal(tookOver.ok, false, tookOver.text);
        assert.equal(tookOver.text, 'The user is controlling tab t1; wait or ask them.');
        assert.equal(tab.controller, 'user');
        assert.deepEqual(sent, ['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseReleased'], 'the press is moved out of the page and released there');
        manager.userActions.releaseControl({ tabId: 't1' });
        assert.notEqual(await status(), 'clicked', 'the button was not clicked');
        const pointer = JSON.parse((await run('browser_evaluate', { tab: 't1', expression: 'JSON.stringify(window.__pointer)' })).text);
        assert.deepEqual(
          pointer,
          ['pointerdown:b', 'mousedown:b', 'pointerup:HTML', 'mouseup:HTML', 'click:HTML'],
          `released outside the button (capture: ${capture})`
        );
        // No stuck press: the next agent click works normally (captured or not).
        assert.equal((await run('browser_click', { tab: 't1', ref: pressRef })).ok, true);
        assert.equal(await status(), 'clicked');
        assert.ok(JSON.parse((await run('browser_evaluate', { tab: 't1', expression: 'JSON.stringify(window.__pointer)' })).text).includes('click:b'));
      }
    }

    // Popups keep their opener (postMessage back, window.close) and form POST bodies.
    {
      const signer = { threadId: 'thread-d', projectPath: projectDir, accessMode: 'full-access' };
      const opened = await run('browser_open', { url: `${origin}/opener` }, signer);
      assert.equal(opened.ok, true, opened.text);
      const openerId = /Opened tab (t\d+)/.exec(opened.text)[1];
      const before = manager.tabs.size;
      const snapOpener = await run('browser_snapshot', { tab: openerId }, signer);
      await run('browser_click', { tab: openerId, ref: refOf(snapOpener.text, /button "Sign in with popup"/) }, signer);
      const popupEvent = await waitUntil(
        () => events.find((entry) => entry.payload?.event?.type === 'popup-opened' && entry.payload.event.openerTabId === openerId)?.payload.event,
        'the popup tab'
      );
      assert.equal(popupEvent.ownerKey, 'thread-d', 'the popup belongs to the opener\'s owner');
      const posted = await run('browser_wait_for', { tab: openerId, text: 'got:signed-in', timeout_ms: 5000 }, signer);
      assert.equal(posted.ok, true, posted.text);
      assert.match((await run('browser_evaluate', { tab: openerId, expression: "document.getElementById('status').textContent" }, signer)).text, /got:signed-in:from-popup/);
      await waitUntil(() => !manager.findTab(popupEvent.tabId), 'window.close() closes the popup tab');
      assert.equal(manager.tabs.size, before);
      // target=_blank form POST: the new tab gets the body.
      await run('browser_click', { tab: openerId, ref: refOf(snapOpener.text, /button "Post to new tab"/) }, signer);
      const echoed = await waitUntil(
        () => manager.state().tabs.find((entry) => entry.ownerKey === 'thread-d' && /^Echo /.test(entry.title)),
        'the POST tab'
      );
      assert.equal(echoed.title, 'Echo who=durango');
      // The URL policy still applies to popups.
      const limitedSigner = { ...signer, accessMode: 'workspace-write' };
      const count = manager.tabs.size;
      await run('browser_evaluate', { tab: openerId, expression: "window.open('data:text/html,<title>Inline</title>'); 1" }, limitedSigner);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(manager.tabs.size, count, 'a blocked popup opens no tab');
      assert.match(manager.findTab(openerId).lastBlocked ?? '', /Top-level data: URLs are blocked/);
      manager.userActions.closeThreadTabs({ threadId: 'thread-d' });
    }

    // A finished thread's tabs close, except ones the person opened or is driving.
    {
      await run('browser_open', { url: `${origin}/two`, new_tab: true });
      const agentTabs = [...manager.tabs.values()].filter((tab) => tab.threadId === 'thread-a' && tab.openedBy === 'agent');
      assert.ok(agentTabs.length >= 2, 'thread-a has agent tabs to close');
      const driven = agentTabs[0];
      manager.userActions.takeControl({ tabId: driven.id });
      for (const tab of agentTabs.slice(1)) manager.userActions.releaseControl({ tabId: tab.id });
      manager.userActions.closeThreadTabs({ threadId: 'thread-a', finished: true });
      const left = [...manager.tabs.values()].filter((tab) => tab.threadId === 'thread-a').map((tab) => tab.id).sort();
      assert.deepEqual(left, [driven.id, userTab.tabId].sort(), 'only the adopted tab and the driven tab stay');
    }

    // Closing a thread's tabs.
    manager.userActions.closeThreadTabs({ threadId: 'thread-a' });
    assert.equal([...manager.tabs.values()].filter((tab) => tab.threadId === 'thread-a').length, 0);
    assert.match((await run('browser_close', {})).text, /no browser tab yet/);
  } finally {
    manager.closeAll();
    server.close();
    window.destroy();
  }

  console.log('builtin browser: ok');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  app.exit(process.exitCode ?? 0);
}
};
void main();
