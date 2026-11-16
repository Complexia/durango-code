// The app tools (src/main/app-tools.js) on a real Electron window: the
// snapshot lists what can be used with refs, and clicks, typing, keys and
// scrolling arrive as real input, including inside a sandboxed theme widget.
//
//   node scripts/run-electron-test.mjs scripts/test-app-tools.mjs
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

import { APP_TOOL_NAMES, appBridgeToolDefinitions, appMcpToolDefinitions, parseKey, runAppTool } from '../src/main/app-tools.js';

const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; font: 13px sans-serif; }
  .app-shellbar { height: 40px; display: flex; gap: 8px; align-items: center; padding: 0 8px; }
  .sidebar { position: absolute; top: 40px; left: 0; width: 200px; bottom: 0; }
  .row { cursor: pointer; padding: 6px; }
  .row span { cursor: pointer; }
  .composer-shell { position: absolute; left: 220px; right: 20px; bottom: 20px; }
  #list { position: absolute; left: 220px; top: 60px; width: 300px; height: 200px; overflow: auto; }
  #list div { height: 40px; }
  .gone { display: none; }
  iframe.theme-control-widget { border: 0; width: 28px; height: 28px; }
</style></head><body>
  <div class="app-shellbar">
    <button id="settings" aria-label="Settings" aria-pressed="false" onclick="window.log.push('settings'); this.setAttribute('aria-pressed', 'true')">⚙</button>
    <span data-theme-control="snow-toggle"><iframe class="theme-control-widget" title="Snowfall on / off" sandbox="allow-scripts"
      srcdoc="<button id=b style='width:28px;height:28px' onclick='parent.postMessage(&quot;widget-click&quot;, &quot;*&quot;)'>*</button>"></iframe></span>
    <button class="gone">Hidden</button>
    <span data-theme-control="name-widget"><iframe class="theme-control-widget" title="Name widget" sandbox="allow-scripts" style="width: 140px"
      srcdoc="<input id=n value='old value' style='width:130px'>"></iframe></span>
  </div>
  <div class="sidebar">
    <h2>Threads</h2>
    <div class="row" onclick="window.log.push('thread-1')"><span>Misty pines</span></div>
    <div class="row" onclick="window.log.push('thread-2')"><span>Fix PDFs</span></div>
    <div class="row" role="button" tabindex="0" onclick="window.log.push('thread-3')"><span>Row three</span>
      <input aria-label="Rename thread" value="Row three" onclick="event.stopPropagation()">
      <button aria-label="Thread menu" onclick="event.stopPropagation(); window.log.push('menu-3')">⋯</button></div>
  </div>
  <div id="list">${Array.from({ length: 30 }, (_, index) => `<div>Item ${index}</div>`).join('')}</div>
  <div class="composer-shell">
    <textarea id="prompt" placeholder="Ask anything" onkeydown="if (event.key === 'Enter') { window.log.push('send:' + this.value); event.preventDefault(); } if (event.key === 'k' && event.metaKey) window.log.push('meta-k');"></textarea>
    <input id="name" value="old name" aria-label="Thread name">
  </div>
  <script>
    window.log = [];
    addEventListener('message', (event) => window.log.push(event.data));
    addEventListener('keydown', (event) => { if (event.key === 'Escape') window.log.push('escape'); if (event.key === 'k' && (event.metaKey || event.ctrlKey)) window.log.push('shortcut-k'); });
  </script>
</body></html>`;

const main = async () => {
  const timer = setTimeout(() => {
    console.error('app tools: timed out');
    app.exit(1);
  }, 60000);
  try {
    await app.whenReady();
    const win = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
      // Input reaches a sandboxed (out-of-process) widget frame only once the
      // window has painted: the compositor routes it by hit-testing. Shown
      // without focus, so the test does not take over the screen.
      win.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const sender = win.webContents;
      // Some environments (no window server, a locked screen) keep even a shown
      // window hidden to the page; real input then can't reach a widget frame.
      const onScreen = (await sender.executeJavaScript('document.visibilityState')) === 'visible';
      if (!onScreen) console.log('app tools: the window stays hidden here; skipped the widget input checks');
      const context = { getSender: () => sender, threadId: 't', accessMode: 'full-access' };
      const log = () => sender.executeJavaScript('window.log.slice()');
      const tool = async (name, args) => {
        if (process.env.APP_TOOLS_DEBUG) console.log('→', name, JSON.stringify(args));
        const result = await runAppTool(name, args, context);
        assert.equal(result.ok, true, `${name} ${JSON.stringify(args)}: ${result.text}`);
        return result.text;
      };
      const refFor = (text, pattern) => {
        const line = text.split('\n').find((entry) => pattern.test(entry));
        assert.ok(line, `snapshot lists ${pattern}:\n${text}`);
        return line.trim().split(' ')[0];
      };

      // --- Listing: definitions, access modes, key parsing ------------------------------------------
      assert.deepEqual(appMcpToolDefinitions('full-access').map((tool) => tool.name), [...APP_TOOL_NAMES]);
      assert.deepEqual(appMcpToolDefinitions('read-only').map((tool) => tool.name), ['app_snapshot']);
      // Bridge providers (Codex approves every orion tool) get actions only in Full access.
      assert.deepEqual(appBridgeToolDefinitions('workspace-write').map((tool) => tool.name), ['app_snapshot']);
      assert.deepEqual(appBridgeToolDefinitions('full-access').map((tool) => tool.name), [...APP_TOOL_NAMES]);
      const bridged = await runAppTool('app_click', { x: 1, y: 1 }, { ...context, accessMode: 'workspace-write', requireFullAccess: true });
      assert.equal(bridged.ok, false);
      assert.match(bridged.text, /needs Full access/);
      assert.equal((await runAppTool('app_snapshot', {}, { ...context, accessMode: 'workspace-write', requireFullAccess: true })).ok, true);
      assert.equal((await runAppTool('app_click', { x: 1, y: 1 }, { ...context, accessMode: 'read-only' })).ok, false, 'Read only refuses actions');
      assert.equal((await runAppTool('app_snapshot', {}, { ...context, getSender: () => null })).ok, false);
      assert.deepEqual(parseKey('CmdOrCtrl+Shift+p', 'darwin'), { key: 'P', code: 'KeyP', keyCode: 80, text: 'P', modifiers: ['meta', 'shift'] });
      assert.deepEqual(parseKey('Control+,', 'linux'), { key: ',', code: 'Comma', keyCode: 188, text: ',', modifiers: ['control'] });
      assert.deepEqual(parseKey('ArrowDown'), { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, modifiers: [] });
      assert.deepEqual(parseKey('f5'), { key: 'F5', code: 'F5', keyCode: 116, modifiers: [] });
      assert.equal(parseKey('+').key, '+');
      assert.equal(parseKey('Hyper+K'), null);
      assert.equal(parseKey('Banana'), null);

      // --- Snapshot ---------------------------------------------------------------------------------
      let snap = await tool('app_snapshot', {});
      assert.match(snap, /^Durango Code window 900x\d+:/);
      assert.match(snap, /Title bar:\n/);
      assert.match(snap, /e\d+ button "Settings" \[\d+,\d+ \d+x\d+\] \(unpressed|e\d+ button "Settings" \[[^\]]+\]/);
      assert.match(snap, /theme widget "Snowfall on \/ off" .*theme control snow-toggle/);
      assert.match(snap, /Sidebar:\n\s+heading "Threads"/);
      assert.match(snap, /clickable "Misty pines"/);
      assert.doesNotMatch(snap, /Hidden/, 'hidden elements are left out');
      assert.doesNotMatch(snap, /clickable "Misty pines".*\n.*clickable "Misty pines"/, 'a pointer span inside a clickable row is not listed twice');
      assert.match(snap, /Prompt box:\n.*textbox "Ask anything"/);
      assert.match(snap, /textbox "Thread name" .*value: "old name"/);
      // Real controls inside a listed row keep their own refs.
      assert.match(snap, /button "Row three/);
      assert.match(snap, /textbox "Rename thread"/);
      assert.match(snap, /button "Thread menu"/);
      const filtered = await tool('app_snapshot', { filter: 'misty' });
      assert.equal(filtered.split('\n').filter((line) => /^\s+e\d+/.test(line)).length, 1, filtered);
      // A ref from an older snapshot never names something else: numbers keep counting.
      const oldMisty = refFor(filtered, /Misty pines/);
      const newer = await tool('app_snapshot', { filter: 'fix' });
      assert.notEqual(refFor(newer, /Fix PDFs/), oldMisty);
      const stale0 = await runAppTool('app_click', { ref: oldMisty }, context);
      assert.equal(stale0.ok, false);
      assert.match(stale0.text, /not in the latest app_snapshot/);

      // --- Click: a button, a clickable row, a sandboxed widget (real input reaches the iframe) ------
      snap = await tool('app_snapshot', {});
      await tool('app_click', { ref: refFor(snap, /button "Settings"/) });
      await tool('app_click', { ref: refFor(snap, /clickable "Fix PDFs"/) });
      await tool('app_click', { ref: refFor(snap, /button "Thread menu"/) });
      if (onScreen) await tool('app_click', { ref: refFor(snap, /theme widget "Snowfall/) });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(await log(), ['settings', 'thread-2', 'menu-3', ...(onScreen ? ['widget-click'] : [])]);
      assert.match(await tool('app_snapshot', { filter: 'settings' }), /\(pressed/);
      const stale = await runAppTool('app_click', { ref: 'e999' }, context);
      assert.equal(stale.ok, false);
      assert.match(stale.text, /not in the latest app_snapshot/);
      assert.equal((await runAppTool('app_click', { ref: 'button' }, context)).ok, false);
      assert.equal((await runAppTool('app_click', {}, context)).ok, false);

      // --- Type, clear, submit, keys ----------------------------------------------------------------
      snap = await tool('app_snapshot', {});
      await tool('app_type', { ref: refFor(snap, /textbox "Thread name"/), text: 'Snowfall', clear: true });
      assert.equal(await sender.executeJavaScript('document.getElementById("name").value'), 'Snowfall');
      if (onScreen) {
        // Clearing works in whichever frame has focus, a widget's too.
        await tool('app_type', { ref: refFor(snap, /theme widget "Name widget"/), text: 'NEW', clear: true });
        const values = await Promise.all(sender.mainFrame.frames.map((frame) => frame.executeJavaScript('document.getElementById("n")?.value ?? null').catch(() => null)));
        assert.ok(values.includes('NEW'), `the widget field holds only the new text: ${JSON.stringify(values)}`);
      }
      await tool('app_type', { ref: refFor(snap, /textbox "Ask anything"/), text: 'hello there', submit: true });
      assert.equal(await sender.executeJavaScript('document.getElementById("prompt").value'), 'hello there');
      assert.ok((await log()).includes('send:hello there'), 'submit presses Enter in the field');
      await tool('app_press', { key: 'Escape' });
      await tool('app_press', { key: 'CmdOrCtrl+K' });
      assert.ok((await log()).includes('escape'));
      assert.ok((await log()).includes('shortcut-k'));
      assert.equal(await sender.executeJavaScript('document.getElementById("prompt").value'), 'hello there', 'a shortcut types no character');
      assert.equal((await runAppTool('app_press', { key: 'Hyper+K' }, context)).ok, false);

      // --- Hidden window: clicks go to the element; a widget frame says why it cannot ----------
      win.hide();
      await new Promise((resolve) => setTimeout(resolve, 300));
      if ((await sender.executeJavaScript('document.visibilityState')) === 'hidden') {
        await sender.executeJavaScript('window.log.length = 0; document.getElementById("settings").setAttribute("aria-pressed", "false")');
        snap = await tool('app_snapshot', {});
        const hiddenClick = await tool('app_click', { ref: refFor(snap, /button "Settings"/) });
        assert.match(hiddenClick, /window is hidden/);
        assert.deepEqual(await log(), ['settings']);
        const widget = await runAppTool('app_click', { ref: refFor(snap, /theme widget "Snowfall/) }, context);
        assert.equal(widget.ok, false);
        assert.match(widget.text, /own frame/);
        await tool('app_type', { ref: refFor(snap, /textbox "Thread name"/), text: ' 2' });
        assert.equal(await sender.executeJavaScript('document.getElementById("name").value'), 'Snowfall 2', 'typing reaches a hidden window');
      } else {
        console.log('app tools: hidden window stays visible to the page here; skipped the hidden checks');
      }
      win.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // --- Scroll -----------------------------------------------------------------------------------
      const before = await sender.executeJavaScript('document.getElementById("list").scrollTop');
      await tool('app_scroll', { x: 370, y: 160, dy: 200 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = await sender.executeJavaScript('document.getElementById("list").scrollTop');
      assert.ok(after > before, `scrolled the list (${before} → ${after})`);

      console.log('app tools: ok');
    } finally {
      win.destroy();
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    app.exit(process.exitCode ?? 0);
  }
};
void main();
