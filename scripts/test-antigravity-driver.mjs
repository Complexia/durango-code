// Antigravity (agy) provider checks. Unit checks always run; set
// AGY_LIVE=1 to also drive real `agy acp` turns (needs a signed-in agy on
// PATH; uses the cheapest Gemini model). Run through
// scripts/run-electron-test.mjs, which exits 0 even on failure: read the
// PASS/FAIL lines.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import {
  antigravityStatsFromPromptResult,
  antigravityToolLabel,
  createAntigravityAcpDriver,
} from '../src/main/antigravity-driver.js';
import { parseAntigravityModelsOutput } from '../src/main/models.js';
import { parseAntigravityLoginUrl, parseAntigravityModelRows } from '../src/main/provider-updates.js';
import { commandForModel } from '../src/main/command-for-model.js';

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n${error?.stack ?? error}`);
  }
};

await check('parses `agy models` output', () => {
  const models = parseAntigravityModelsOutput(
    'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n'
  );
  assert.deepEqual(
    models.map((model) => [model.id, model.label, model.command, model.providerId]),
    [
      ['antigravity:gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)', 'agy', 'antigravity'],
      ['antigravity:claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)', 'agy', 'antigravity'],
    ]
  );
  assert.equal(parseAntigravityModelsOutput('Error: authentication required').length, 0);
  assert.equal(parseAntigravityModelRows('Fetching available models...\na\tA\n').length, 1);
});

await check('per-turn usage from the prompt result', () => {
  assert.deepEqual(
    antigravityStatsFromPromptResult({
      stopReason: 'end_turn',
      usage: { inputTokens: 11095, outputTokens: 38, cachedReadTokens: 6911, thoughtTokens: 0, totalTokens: 18044 },
    }),
    { inputTokens: 11095, outputTokens: 38, cachedReadTokens: 6911, reasoningTokens: 0, totalTokens: 18044 }
  );
  assert.equal(antigravityStatsFromPromptResult({}), null);
});

await check('finds the Google sign-in link', () => {
  const url =
    'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=abc';
  assert.equal(parseAntigravityLoginUrl(`Open this link in a browser to log in with Google:\n\n  ${url}\n\nThen paste`), url);
  assert.equal(parseAntigravityLoginUrl(`partial ${url}`), null);
});

await check('command and labels', () => {
  assert.deepEqual(
    commandForModel(
      { providerId: 'antigravity', slug: 'gemini-3.8-flash-low' },
      { prompt: 'x', projectPath: '/tmp', providerOptions: { extraArgs: '--add-dir /a' } }
    ),
    ['agy', 'acp', '--add-dir', '/a']
  );
  assert.equal(antigravityToolLabel('run_command'), 'Command');
  assert.equal(antigravityToolLabel('mcp_orion_read_thread'), 'orion · read thread');
});

// Drives one real turn and records what the driver reported.
const runTurn = ({ cwd, accessMode, promptText, resumeSessionId = null }) =>
  new Promise((resolve) => {
    const child = spawn('agy', ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const seen = { text: '', activities: new Map(), sessionId: null, fatal: null, result: null, resumeFallback: false };
    const done = () => {
      try {
        child.kill();
      } catch {}
      resolve(seen);
    };
    const timer = setTimeout(() => {
      seen.fatal = seen.fatal ?? 'timeout';
      done();
    }, 180000);
    const driver = createAntigravityAcpDriver({
      child,
      cwd,
      model: { providerId: 'antigravity', slug: 'gemini-3.8-flash-low' },
      promptText,
      resumeSessionId,
      accessMode,
      callbacks: {
        onSessionId: (id) => {
          seen.sessionId = id;
        },
        onReasoning: () => {},
        onText: (text) => {
          seen.text += text;
        },
        onActivity: (activity) => seen.activities.set(activity.key, activity),
        onResumeFallback: () => {
          seen.resumeFallback = true;
        },
        onTurnEnd: (result) => {
          seen.result = result;
          clearTimeout(timer);
          done();
        },
        onFatal: (message) => {
          seen.fatal = message;
          clearTimeout(timer);
          done();
        },
      },
    });
    let buffer = '';
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          driver.handleMessage(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.resume();
    driver.start();
  });

if (process.env.AGY_LIVE === '1') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-driver-')));
  const workspace = path.join(root, 'ws');
  const outside = path.join(root, 'outside.txt');
  fs.mkdirSync(workspace);
  let sessionId = null;

  await check('live: workspace write allows edits inside, denies commands and outside writes', async () => {
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'workspace-write',
      promptText: `Do exactly these three steps, each with a tool call, even if one fails: 1) create the file ${path.join(workspace, 'inside.txt')} containing "hi"; 2) create the file ${outside} containing "no"; 3) run the shell command \`echo ran\`. Then say DONE.`,
    });
    sessionId = seen.sessionId;
    const activities = [...seen.activities.values()];
    console.log(activities.map((a) => `  ${a.status} ${a.title}${a.output ? ` :: ${String(a.output).slice(0, 90).replace(/\n/g, ' ')}` : ''}`).join('\n'));
    assert.equal(seen.fatal, null);
    assert.ok(seen.result?.usage, 'usage reported');
    assert.ok(fs.existsSync(path.join(workspace, 'inside.txt')), 'inside write allowed');
    assert.ok(!fs.existsSync(outside), 'outside write denied');
    // Denied, or cancelled by agy itself after the outside write was denied:
    // either way the command must not have run.
    assert.ok(
      !activities.some((a) => a.type === 'command' && a.status === 'done'),
      'command did not run'
    );
  });

  await check('live: read only denies writes', async () => {
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'read-only',
      promptText: `Create the file ${path.join(workspace, 'ro.txt')} containing "x" using a tool, then say DONE.`,
    });
    assert.equal(seen.fatal, null);
    assert.ok(!fs.existsSync(path.join(workspace, 'ro.txt')), 'read-only write denied');
  });

  await check('live: resume keeps the conversation', async () => {
    assert.ok(sessionId, 'first turn reported a session id');
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'full-access',
      resumeSessionId: sessionId,
      promptText: 'What was the name of the first file I asked you to create? Answer with just the file name.',
    });
    assert.equal(seen.fatal, null);
    assert.equal(seen.resumeFallback, false);
    assert.equal(seen.sessionId, sessionId);
    assert.match(seen.text, /inside\.txt/);
  });

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
app.exit(failures ? 1 : 0);
