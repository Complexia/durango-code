// Live Electron runtime CSP smoke test: verifies that RENDERER_CSP_PROD +
// rendererCspResponseHeaders allow ES module workers (Shiki), blob: module
// workers (Monaco), sandboxed about:srcdoc visuals/theme scenes, orion-attachment:
// media & PDF iframes, and built-in browser WebContentsViews while actively
// blocking eval, remote fetch, remote CSS @import, data: workers, and cleartext
// http: images.
//
//   node scripts/run-electron-test.mjs scripts/test-renderer-csp-electron.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, protocol } from 'electron';
import { RENDERER_CSP_PROD, rendererCspResponseHeaders } from '../src/renderer-csp.js';
import { buildSceneDocument } from '../src/ui-themes.js';
import { buildVisualDocument } from '../src/app/visualDocument.ts';

protocol.registerSchemesAsPrivileged([
  { scheme: 'orion-attachment', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'orion-source-attachment', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const minimalPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
);
const minimalPdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

app.disableHardwareAcceleration();

let exitCode = 0;
app.whenReady().then(async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-csp-electron-'));
  const guestServer = http.createServer((req, res) => {
    if (req.url === '/pixel.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(minimalPng);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Guest</title><script>window.__guestEval = new Function("return 42")();</script>');
  });

  try {
  await new Promise((resolve) => guestServer.listen(0, '127.0.0.1', resolve));
  const guestOrigin = `http://127.0.0.1:${guestServer.address().port}`;

  protocol.handle('orion-attachment', (req) => {
    if (req.url.includes('.pdf')) {
      return new Response(minimalPdf, { headers: { 'content-type': 'application/pdf' } });
    }
    return new Response(minimalPng, { headers: { 'content-type': 'image/png' } });
  });
  protocol.handle('orion-source-attachment', () =>
    new Response(minimalPng, { headers: { 'content-type': 'image/png' } })
  );

  await fs.writeFile(path.join(tempDir, 'helper.mjs'), 'export const answer = 7;\n');
  await fs.writeFile(
    path.join(tempDir, 'module-worker.mjs'),
    "import { answer } from './helper.mjs'; self.postMessage(answer);\n"
  );
  await fs.writeFile(
    path.join(tempDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP_PROD}"></head><body><div id="root">ok</div></body></html>`
  );

  const mainIds = new Set();
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, plugins: true },
  });
  mainIds.add(win.webContents.id);
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const next = rendererCspResponseHeaders(details, {
      isMainWindow: (id) => mainIds.has(id),
      devServerUrl: null,
    });
    callback(next ? { responseHeaders: next } : {});
  });

  await win.loadFile(path.join(tempDir, 'index.html'));

  const sceneDoc = buildSceneDocument('<canvas id="c"></canvas><script>window.durango.on("state",()=>{});</script>');
  const visualDoc = buildVisualDocument('<div>hi</div><script>window.parent.postMessage({source:"durango-visual",type:"resize",height:120},"*");</script>', {});

  const res = await win.webContents.executeJavaScript(`(async () => {
    const violations = [];
    window.addEventListener('securitypolicyviolation', (e) => {
      violations.push({ dir: e.violatedDirective, blocked: e.blockedURI });
    });

    // 1. Shiki-style ES module worker ('self')
    const moduleWorkerOk = await new Promise((resolve) => {
      const w = new Worker('./module-worker.mjs', { type: 'module' });
      w.onmessage = (e) => { w.terminate(); resolve(e.data === 7); };
      w.onerror = () => resolve(false);
    });

    // 2. Monaco-style blob: module bootstrap worker importing same-origin ESM
    const helperUrl = new URL('./helper.mjs', location.href).href;
    const blobWorkerOk = await new Promise((resolve) => {
      const blob = new Blob([\`import { answer } from \${JSON.stringify(helperUrl)}; self.postMessage(answer);\`], { type: 'text/javascript' });
      const w = new Worker(URL.createObjectURL(blob), { type: 'module' });
      w.onmessage = (e) => { w.terminate(); resolve(e.data === 7); };
      w.onerror = () => resolve(false);
    });

    // 3. Sandboxed about:srcdoc theme scene and show_html visual
    const sceneReady = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2000);
      window.addEventListener('message', (e) => {
        if (e.data?.source === 'durango-theme-scene' && e.data?.type === 'ready') { clearTimeout(t); resolve(true); }
      });
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = ${JSON.stringify(sceneDoc)};
      document.body.appendChild(f);
    });
    const visualReady = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2000);
      window.addEventListener('message', (e) => {
        if (e.data?.source === 'durango-visual' && e.data?.type === 'resize') { clearTimeout(t); resolve(true); }
      });
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = ${JSON.stringify(visualDoc)};
      document.body.appendChild(f);
    });

    // 4. orion-attachment:, orion-source-attachment:, data: images + PDF iframe
    const loadImg = (src) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = src;
    });
    const attachImg = await loadImg('orion-attachment://local/media?path=/tmp/a.png');
    const sourceImg = await loadImg('orion-source-attachment://source/o/r/att_1?account=u1');
    const dataImg = await loadImg('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=');
    const pdfLoaded = await new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.onload = () => resolve(true);
      f.onerror = () => resolve(false);
      f.src = 'orion-attachment://local/media?path=/tmp/doc.pdf';
      document.body.appendChild(f);
    });

    const unexpectedViolations = [...violations];

    // 5. Blocked actions: eval, remote fetch, remote CSS @import, data: worker, cleartext http: image
    let evalBlocked = false;
    try { new Function('return 1')(); } catch { evalBlocked = true; }
    let fetchBlocked = false;
    try { await fetch('https://example.com/'); } catch { fetchBlocked = true; }
    let dataWorkerBlocked = false;
    try {
      const dw = new Worker('data:text/javascript,self.postMessage(1)');
      dataWorkerBlocked = await new Promise((resolve) => {
        dw.onerror = () => resolve(true);
        dw.onmessage = () => resolve(false);
        setTimeout(() => resolve(true), 300);
      });
      dw.terminate();
    } catch {
      dataWorkerBlocked = true;
    }
    const httpImgLoaded = await loadImg(${JSON.stringify(`${guestOrigin}/pixel.png`)});
    const style = document.createElement('style');
    style.textContent = '@import url("https://example.com/evil.css");';
    document.head.appendChild(style);
    await new Promise((r) => setTimeout(r, 200));

    return {
      moduleWorkerOk,
      blobWorkerOk,
      sceneReady,
      visualReady,
      attachImg,
      sourceImg,
      dataImg,
      pdfLoaded,
      unexpectedViolations,
      evalBlocked,
      fetchBlocked,
      dataWorkerBlocked,
      httpImgLoaded,
      allViolations: violations,
    };
  })()`);

  assert.equal(res.moduleWorkerOk, true, 'ES module worker runs under CSP');
  assert.equal(res.blobWorkerOk, true, 'Monaco-style blob: module worker runs under CSP');
  assert.equal(res.sceneReady, true, 'ThemeSceneFrame srcdoc runs under CSP');
  assert.equal(res.visualReady, true, 'HtmlVisual srcdoc runs under CSP');
  assert.equal(res.attachImg, true, 'orion-attachment: image loads');
  assert.equal(res.sourceImg, true, 'orion-source-attachment: image loads');
  assert.equal(res.dataImg, true, 'data: image loads');
  assert.equal(res.pdfLoaded, true, 'orion-attachment: PDF iframe loads');
  assert.deepEqual(res.unexpectedViolations, [], `zero unexpected CSP violations: ${JSON.stringify(res.unexpectedViolations)}`);
  assert.equal(res.evalBlocked, true, 'eval / new Function blocked');
  assert.equal(res.fetchBlocked, true, 'remote fetch blocked');
  assert.equal(res.dataWorkerBlocked, true, 'data: worker blocked');
  assert.equal(res.httpImgLoaded, false, 'cleartext http: image blocked in prod CSP');
  assert.ok(
    res.allViolations.some((v) => v.dir.startsWith('style-src') && v.blocked.includes('example.com')),
    'remote CSS @import blocked'
  );

  // 6. Built-in browser WebContentsView is unaffected by mainWindow CSP.
  const guestView = new WebContentsView({
    webPreferences: { partition: 'persist:csp-smoke-browser', sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.contentView.addChildView(guestView);
  guestView.setBounds({ x: 0, y: 0, width: 320, height: 240 });
  await guestView.webContents.loadURL(`${guestOrigin}/`);
  assert.equal(await guestView.webContents.executeJavaScript('window.__guestEval'), 42);

  win.destroy();
  console.log('Electron runtime CSP smoke checks passed.');
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    guestServer.closeAllConnections?.();
    guestServer.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
