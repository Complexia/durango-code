// The bridge shim's compact listing (src/mcp-bridge-shim.cjs --compact-tools):
// providers that put every listed tool's full definition in each request
// (Kimi, OpenCode, Muse, fx) get one-line summaries, and load_tools serves
// full descriptions and schemas on demand. Providers that defer MCP tools
// themselves (Codex, Grok, Cursor) keep the full list.
//
//   node scripts/run-electron-test.mjs scripts/test-mcp-bridge-compact.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

import { handleMcpBridgeConnection, mcpBridgeSessions } from '../src/main/mcp-bridge.js';
import { createOnDemandMcps } from '../src/main/mcp-on-demand.js';
import {
  isMcpBridgeProvider,
  isPreapprovedOrionTool,
  providerDefersMcpToolsNatively,
} from '../src/main/thread-reader-routing.js';
import shimSource from '../src/mcp-bridge-shim.cjs?raw';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-bridge-compact-'));
const shimPath = path.join(testRoot, 'shim.cjs');
await fs.writeFile(shimPath, shimSource);
const socketPath = path.join(testRoot, 'bridge.sock');
const fakeImage = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };

// A run with everything on: built-in browser, other machines, a connected app
// (load_tools / call_app_tool), simulators (--devices) and the theme tools.
const appCalls = [];
const onDemandMcps = createOnDemandMcps([{ name: 'notion', transport: 'http', url: 'http://127.0.0.1:9/mcp' }], {
  connect: async () => ({
    listTools: async () => ({
      tools: [{ name: 'search', description: 'Search Notion pages.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }],
    }),
    callTool: async (request) => {
      appCalls.push(request);
      return { content: [{ type: 'text', text: 'found' }] };
    },
    close: async () => {},
  }),
});
mcpBridgeSessions.set('tok', {
  getSender: () => null,
  threadId: 't',
  runId: 'r',
  projectPath: testRoot,
  providerId: 'kimi',
  accessMode: 'full-access',
  browserMode: 'builtin',
  machinesEnabled: true,
  onDemandMcps,
  abortController: new AbortController(),
});

// The real socket handler, except device_screenshot answers with an image
// block (no simulator here) so content passthrough can be checked.
const forwarded = [];
const bridge = net.createServer((socket) => {
  let pending = '';
  socket.on('data', (chunk) => {
    pending += chunk;
    const newline = pending.indexOf('\n');
    if (newline === -1) return;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    const request = JSON.parse(line);
    forwarded.push(request);
    if (request.tool === 'device_screenshot') {
      socket.write(`${JSON.stringify({ id: request.id, ok: true, text: 'shot', content: [fakeImage, { type: 'text', text: 'shot' }] })}\n`);
      return;
    }
    const proxy = new EventEmitter();
    proxy.write = (data) => socket.write(data);
    handleMcpBridgeConnection(proxy);
    proxy.emit('data', Buffer.from(`${line}\n`));
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => bridge.listen(socketPath, resolve));

const startShim = (extraArgs) => {
  const child = spawn(process.execPath, [shimPath, '--socket', socketPath, '--token', 'tok', '--devices', ...extraArgs], {
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
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { child, call };
};
const text = (reply) => reply.result.content.map((block) => block.text ?? '').join('\n');
const size = (value) => JSON.stringify(value).length;

const full = startShim(['--instructions']);
const compact = startShim(['--compact-tools']);
try {
  // --- Which providers get what -----------------------------------------------------------
  for (const id of ['codex', 'grok', 'cursor']) assert.equal(providerDefersMcpToolsNatively(id), true, id);
  for (const id of ['kimi', 'opencode', 'muse', 'fx']) {
    assert.equal(isMcpBridgeProvider(id), true, id);
    assert.equal(providerDefersMcpToolsNatively(id), false, `${id} gets the compact list`);
  }
  for (const mode of ['read-only', 'workspace-write', 'full-access']) {
    assert.equal(isPreapprovedOrionTool('load_tools', mode), true, `load_tools is pre-approved in ${mode}, as for Claude`);
  }
  assert.equal(isPreapprovedOrionTool('call_app_tool', 'workspace-write'), false, 'app tools keep their approval');

  // --- Server instructions (Codex): one line on what orion is for ---------------------------
  const fullInit = await full.call('initialize', { protocolVersion: '2025-06-18' });
  assert.match(fullInit.result.instructions, /^Durango Code, the app running you: subagents on other models, other threads, Durango Chat, user memory, user actions, secrets, HTML visuals, built-in browser, simulators, other machines, app theme, app window, project notes, connected apps\.$/);
  assert.ok(fullInit.result.instructions.length <= 246, 'fits the namespace line Codex shows (250 characters)');
  const compactInit = await compact.call('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(compactInit.result.instructions, undefined, 'only with --instructions (fx repeats it on every tool)');

  // --- Full list: unchanged for providers that defer natively --------------------------------
  const fullTools = (await full.call('tools/list')).result.tools;
  const fullNames = fullTools.map((tool) => tool.name);
  for (const name of ['spawn_subagent', 'request_secret', 'show_html', 'device_screenshot', 'browser_open', 'machine_exec', 'set_app_theme', 'app_snapshot', 'app_click', 'load_tools', 'call_app_tool']) {
    assert.ok(fullNames.includes(name), `the run lists ${name}`);
  }
  assert.equal(fullNames.filter((name) => name === 'load_tools').length, 1);

  // --- Compact list: same tools, summaries and argument names only ---------------------------
  const compactTools = (await compact.call('tools/list')).result.tools;
  const compactNames = compactTools.map((tool) => tool.name);
  assert.equal(compactNames[0], 'load_tools', 'the loader comes first');
  assert.deepEqual([...compactNames].sort(), [...fullNames].sort(), 'every tool is still listed');
  for (const tool of compactTools) {
    const original = fullTools.find((candidate) => candidate.name === tool.name);
    if (tool.name === 'call_app_tool') {
      assert.deepEqual(tool, original, 'call_app_tool is listed in full');
      continue;
    }
    if (tool.name === 'load_tools') continue;
    assert.ok(tool.description.length <= 120, `${tool.name}: one-line summary (${tool.description.length} chars)`);
    assert.ok(!tool.description.includes('\n'), tool.name);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), Object.keys(original.inputSchema.properties ?? {}).sort(), `${tool.name} keeps its argument names`);
    assert.equal(tool.inputSchema.required, undefined, `${tool.name}: nothing required in the listed schema`);
    assert.equal(tool.inputSchema.additionalProperties, undefined, `${tool.name}: extra keys allowed`);
    for (const property of Object.values(tool.inputSchema.properties)) {
      assert.deepEqual(Object.keys(property).filter((key) => key !== 'type' && key !== 'items'), [], `${tool.name}: argument types only`);
      if (property.type === 'array') assert.ok(property.items, `${tool.name}: arrays keep items`);
    }
    assert.deepEqual(tool.annotations, original.annotations, `${tool.name} keeps its annotations`);
  }
  assert.equal(compactTools.find((tool) => tool.name === 'spawn_subagent').description, 'Spawn a Durango Code subagent on a specific model to perform a task.');
  const loader = compactTools[0];
  assert.match(loader.description, /one-line summary only/);
  assert.match(loader.description, /With `apps`: Load the tools of an app the user connected .*notion/, 'the app loader is merged in');
  assert.deepEqual(Object.keys(loader.inputSchema.properties), ['tools', 'apps']);
  assert.equal(loader.annotations.readOnlyHint, true);

  const fullSize = size(fullTools);
  const compactSize = size(compactTools);
  console.log(`orion tool listing (${fullTools.length} tools): full ${fullSize} chars (~${Math.round(fullSize / 4)} tokens), compact ${compactSize} chars (~${Math.round(compactSize / 4)} tokens)`);
  assert.ok(compactSize < fullSize * 0.35, 'the compact list is a fraction of the full one');

  // --- load_tools returns the full definitions ------------------------------------------------
  const listing = await compact.call('tools/call', { name: 'load_tools', arguments: {} });
  assert.equal(listing.result.isError, false);
  assert.match(text(listing), /Durango Code tools you can load: spawn_subagent, stop_subagent, /);
  assert.match(text(listing), /Apps you can load: notion\./, 'and the apps, from the app');
  assert.doesNotMatch(text(listing), /tools you can load: [^\n]*load_tools/, 'the loaders are not loadable');

  const loaded = await compact.call('tools/call', { name: 'load_tools', arguments: { tools: ['set_app_theme', 'mcp__orion__request_secret', 'nope'] } });
  assert.equal(loaded.result.isError, false);
  const payload = JSON.parse(text(loaded));
  for (const name of ['set_app_theme', 'request_secret']) {
    const original = fullTools.find((tool) => tool.name === name);
    assert.deepEqual(payload.tools.find((tool) => tool.name === name), { name, description: original.description, inputSchema: original.inputSchema }, `${name}: full definition`);
  }
  assert.deepEqual(payload.notFound, ['nope']);
  assert.ok(!forwarded.some((request) => request.tool === 'load_tools' && request.args.tools), 'tool definitions are served by the shim itself');

  const appLoad = await compact.call('tools/call', { name: 'load_tools', arguments: { apps: ['notion', 'show_html'] } });
  assert.equal(appLoad.result.isError, false);
  assert.match(text(appLoad), /"name": "show_html"/, 'a Durango Code tool passed as an app loads as a tool');
  assert.match(text(appLoad), /"app": "notion"[\s\S]*"name": "search"/, 'apps load through the app');
  assert.deepEqual(forwarded.filter((request) => request.tool === 'load_tools').at(-1).args, { apps: ['notion'] });
  const appCall = await compact.call('tools/call', { name: 'call_app_tool', arguments: { app: 'notion', tool: 'search', arguments: { q: 'x' } } });
  assert.equal(appCall.result.isError, false);
  assert.equal(text(appCall), 'found');
  assert.deepEqual(appCalls.at(-1), { name: 'search', arguments: { q: 'x' } });

  // --- A call guessed from a summary gets the definition back, once ---------------------------
  const before = forwarded.length;
  const guessed = await compact.call('tools/call', { name: 'spawn_subagent', arguments: { task: 'x' } });
  assert.equal(guessed.result.isError, true);
  assert.match(text(guessed), /^spawn_subagent did not run: `model` is required; `prompt` is required; `task` is not an argument\. Its full definition/);
  assert.match(text(guessed), /"required": \[\s*"model",\s*"prompt"\s*\]/);
  assert.equal(forwarded.length, before, 'the bad call never reached the app');
  const again = await compact.call('tools/call', { name: 'spawn_subagent', arguments: { model: 7, prompt: 'x' } });
  assert.equal(text(again), 'spawn_subagent did not run: `model` must be string.', 'no second copy of the definition');
  const badEnum = await compact.call('tools/call', { name: 'request_secret', arguments: { label: 'Token', reason: 'Deploy.', delivery: 'email' } });
  assert.match(text(badEnum), /`delivery` must be one of "file", "ref"\.$/, 'request_secret was loaded above: no definition repeated');

  // Valid calls run, loaded or not, with their arguments unchanged.
  const spawned = await compact.call('tools/call', { name: 'spawn_subagent', arguments: { model: 'codex:gpt-6-sol', prompt: 'x' } });
  assert.match(text(spawned), /window is no longer available/, `reached the real handler: ${text(spawned)}`);
  assert.deepEqual(forwarded.at(-1), { id: 1, token: 'tok', tool: 'spawn_subagent', args: { model: 'codex:gpt-6-sol', prompt: 'x' } });
  // An optional null is forwarded as sent: the tool decides what it means.
  const nullEffort = await compact.call('tools/call', { name: 'spawn_subagent', arguments: { model: 'codex:gpt-6-sol', prompt: 'x', effort: null } });
  assert.deepEqual(forwarded.at(-1).args, { model: 'codex:gpt-6-sol', prompt: 'x', effort: null });
  assert.match(text(nullEffort), /optional string `effort`/, 'and the handler answers for it');

  // Validation follows the full schema all the way down. browser_click's
  // modifiers are an array of enum strings: an unknown one used to be
  // forwarded and the click silently became a plain click.
  const lastForwarded = () => forwarded.at(-1);
  let mark = lastForwarded();
  const badModifier = await compact.call('tools/call', { name: 'browser_click', arguments: { ref: 'e1', modifiers: ['CommandOrControl'] } });
  assert.equal(badModifier.result.isError, true);
  assert.match(text(badModifier), /^browser_click did not run: `modifiers\[0\]` must be one of "Alt", "Control", "Meta", "Shift"\. Its full definition/);
  assert.equal(lastForwarded(), mark, 'never reached the browser');
  const notArray = await compact.call('tools/call', { name: 'browser_click', arguments: { ref: 'e1', modifiers: 'Shift' } });
  assert.match(text(notArray), /^browser_click did not run: `modifiers` must be array\.$/);
  await compact.call('tools/call', { name: 'browser_click', arguments: { ref: 'e1', modifiers: ['Meta', 'Shift'], button: 'left' } });
  assert.deepEqual(lastForwarded().args, { ref: 'e1', modifiers: ['Meta', 'Shift'], button: 'left' }, 'valid modifiers go through');

  // Nested theme values: backdrop properties, ranges, enums, the token map.
  const theme = async (args) => {
    const before = lastForwarded();
    const reply = await compact.call('tools/call', { name: 'set_app_theme', arguments: args });
    return { reply, text: text(reply), forwarded: lastForwarded() !== before ? lastForwarded().args : null };
  };
  const nestedRange = await theme({ backdrop: { type: 'css', css: 'red', dim: 2 } });
  assert.equal(nestedRange.forwarded, null);
  assert.equal(nestedRange.text, 'set_app_theme did not run: `backdrop.dim` must be at most 0.9.', 'loaded above: no definition repeated');
  const nestedEnum = await theme({ backdrop: { type: 'gif' }, tokens: { accent: 5 }, appearance: 'dim' });
  assert.equal(nestedEnum.forwarded, null);
  assert.match(nestedEnum.text, /`backdrop\.type` must be one of /);
  assert.match(nestedEnum.text, /`tokens\.accent` must be string or null/);
  assert.match(nestedEnum.text, /`appearance` must be one of "dark", "light"/);
  assert.match((await theme({ backdrop: { type: 'css', colour: 'red' } })).text, /`backdrop\.colour` is not an argument/);
  assert.match((await theme({ surface_opacity: 5 })).text, /`surface_opacity` must be at most 1/);
  assert.match((await theme({ panel_blur: '4px' })).text, /`panel_blur` must be number/);
  // Everything the real schema allows passes: nullable unions, the
  // string-or-null token map, enums, in-range numbers.
  const valid = { tokens: { accent: '#ff4fd8', 'bg-base': null }, backdrop: { type: 'css', css: 'red', dim: 0.5, fit: 'cover' }, overlay: null, appearance: 'dark', panel_blur: 12 };
  assert.deepEqual((await theme(valid)).forwarded, valid);
  assert.deepEqual((await theme({ backdrop: null })).forwarded, { backdrop: null });
  // Resets with null reach the handler even where the schema says number
  // (surface_opacity, base_opacity, panel_blur): set_app_theme takes null
  // there as "back to the default".
  const reset = await theme({ surface_opacity: null });
  assert.deepEqual(reset.forwarded, { surface_opacity: null }, '{surface_opacity: null} reaches the handler');
  assert.doesNotMatch(reset.text, /did not run/);
  assert.deepEqual((await theme({ base_opacity: null, panel_blur: null })).forwarded, { base_opacity: null, panel_blur: null });
  // A required argument still can't be null unless its schema allows it.
  assert.match(text(await compact.call('tools/call', { name: 'read_thread', arguments: { thread_id: null } })), /`thread_id` must be string/);

  const shot = await compact.call('tools/call', { name: 'device_screenshot', arguments: {} });
  assert.equal(shot.result.isError, false);
  assert.deepEqual(shot.result.content, [fakeImage, { type: 'text', text: 'shot' }], 'image blocks pass through');
  const unknown = await compact.call('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, -32602);

  // --- Without --compact-tools nothing is checked or rewritten --------------------------------
  const fullBefore = forwarded.length;
  const fullBad = await full.call('tools/call', { name: 'spawn_subagent', arguments: {} });
  assert.match(text(fullBad), /requires string `model` and `prompt`/, 'the real handler answers');
  assert.equal(forwarded.length, fullBefore + 1);
  const fullLoad = await full.call('tools/call', { name: 'load_tools', arguments: { apps: ['notion'] } });
  assert.match(text(fullLoad), /"app": "notion"/, 'load_tools is the app loader alone');

  console.log('mcp bridge compact listing: ok');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  full.child.kill();
  compact.child.kill();
  bridge.close();
  mcpBridgeSessions.delete('tok');
  await onDemandMcps.close();
  await fs.rm(testRoot, { recursive: true, force: true });
  app.exit(process.exitCode ?? 0);
}
