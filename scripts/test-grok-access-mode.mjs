import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import {
  grokPermissionModeForAccessMode,
  grokSessionModeForAccessMode,
} from '../src/main/grok-access-mode.js';

assert.equal(grokSessionModeForAccessMode('read-only'), 'default');
assert.equal(grokSessionModeForAccessMode('workspace-write'), 'default');
assert.equal(grokSessionModeForAccessMode('full-access'), null);
assert.equal(grokPermissionModeForAccessMode('read-only'), 'default');
assert.equal(grokPermissionModeForAccessMode('workspace-write'), 'acceptEdits');
assert.equal(grokPermissionModeForAccessMode('full-access'), null);

const { createGrokAcpDriver } = await import('../src/main/grok-driver.js');
const { commandForModel } = await import('../src/main/command-for-model.js');

const runDriver = async (accessMode, { attachments = [], promptCapabilities } = {}) => {
  const requests = [];
  let driver;
  const child = {
    stdin: {
      write(raw) {
        const request = JSON.parse(raw);
        requests.push(request);
        queueMicrotask(() => {
          if (request.method === 'initialize') {
            driver.handleMessage({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: promptCapabilities ? { promptCapabilities } : {},
              },
            });
            return;
          }
          if (request.method === 'session/new') {
            driver.handleMessage({
              jsonrpc: '2.0',
              id: request.id,
              result: { sessionId: 'session-1' },
            });
            return;
          }
          if (request.method === 'session/prompt') {
            driver.handleMessage({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'done' },
                },
              },
            });
          }
          driver.handleMessage({ jsonrpc: '2.0', id: request.id, result: {} });
        });
      },
    },
  };
  let text = '';
  driver = createGrokAcpDriver({
    child,
    cwd: '/tmp/orion-grok-driver-test',
    promptText: 'Inspect only.',
    attachments,
    resumeSessionId: null,
    accessMode,
    callbacks: {
      onSessionId() {},
      onReasoning() {},
      onText(chunk) {
        text += chunk;
      },
      onActivity() {},
      onFatal(error) {
        throw new Error(error);
      },
      onTurnEnd() {},
    },
  });
  await driver.start();
  assert.equal(text, 'done');
  return requests;
};

const readOnlyRequests = await runDriver('read-only');
assert.deepEqual(
  readOnlyRequests.find((request) => request.method === 'session/set_mode')?.params,
  { sessionId: 'session-1', modeId: 'default' }
);
assert.equal(
  readOnlyRequests.some(
    (request) => request.method === 'session/set_mode' && request.params?.modeId === 'plan'
  ),
  false
);

const workspaceWriteRequests = await runDriver('workspace-write');
assert.equal(
  workspaceWriteRequests.find((request) => request.method === 'session/set_mode')?.params?.modeId,
  'default'
);

const fullAccessRequests = await runDriver('full-access');
assert.equal(
  fullAccessRequests.some((request) => request.method === 'session/set_mode'),
  false
);

// Attachments respect initialize promptCapabilities (images by default, PDFs when embeddedContext is advertised).
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-grok-attach-'));
try {
  const imgPath = path.join(tmpDir, 'shot.png');
  const pdfPath = path.join(tmpDir, 'spec.pdf');
  await fs.writeFile(imgPath, Buffer.from([137, 80, 78, 71]));
  await fs.writeFile(pdfPath, '%PDF-1.7');
  const attachedRequests = await runDriver('read-only', {
    attachments: [
      { path: imgPath, mimeType: 'image/png; charset=binary' },
      { path: pdfPath, mimeType: 'application/pdf' },
    ],
    promptCapabilities: { image: true, embeddedContext: true },
  });
  const promptReq = attachedRequests.find((request) => request.method === 'session/prompt');
  assert.deepEqual(
    promptReq.params.prompt.map((block) => block.type),
    ['text', 'image', 'resource_link']
  );
  assert.equal(promptReq.params.prompt[1].mimeType, 'image/png');
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

const grokModel = { providerId: 'grok', slug: 'grok-4.6' };
const grokCommand = (accessMode) =>
  commandForModel(grokModel, {
    acp: true,
    accessMode,
    projectPath: '/tmp/orion-grok-driver-test',
    prompt: 'Inspect only.',
  });

assert.deepEqual(grokCommand('read-only').slice(0, 4), [
  'grok',
  '--permission-mode',
  'default',
  'agent',
]);
assert.deepEqual(grokCommand('workspace-write').slice(0, 4), [
  'grok',
  '--permission-mode',
  'acceptEdits',
  'agent',
]);
assert.deepEqual(grokCommand('full-access').slice(0, 3), ['grok', '--always-approve', 'agent']);

console.log('ok  Grok access modes keep read-only turns out of plan mode');
app.quit();
